# Activity Naming Convention for Claude Desktop

## Overview

All Claude Desktop activities MUST use the `cdesk.*` namespace to ensure proper isolation from other tools and maintain ActivitySchema v2.0 compliance. This document defines the complete list of standardized activity names.

## Namespace Format

```
cdesk.[verb]_[noun][_modifier]
```

- **Namespace**: Always `cdesk.` (Claude Desktop)
- **Verb**: Present tense, lowercase
- **Noun**: Singular, lowercase
- **Modifier**: Optional, for specificity

## Activity Catalog

### Session Management
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.session_started` | New Claude Desktop session | `session_id`, `version`, `environment` |
| `cdesk.session_resumed` | Existing session continued | `session_id`, `idle_duration_ms` |
| `cdesk.session_ended` | Session terminated | `session_id`, `duration_ms`, `event_count` |
| `cdesk.session_expired` | Session timed out | `session_id`, `last_activity_ms` |

### User Interactions
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.user_asked` | User submitted question | `prompt_tokens`, `question_type`, `has_context` |
| `cdesk.user_clarified` | Follow-up question | `prompt_tokens`, `clarification_type` |
| `cdesk.user_cancelled` | User cancelled operation | `operation_type`, `elapsed_ms` |
| `cdesk.user_rated` | User provided feedback | `rating`, `feedback_text` |

### Claude Responses
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.claude_responded` | Claude provided answer | `model`, `completion_tokens`, `latency_ms`, `cost_usd` |
| `cdesk.claude_clarified` | Claude asked for clarification | `clarification_reason` |
| `cdesk.claude_suggested` | Claude offered suggestions | `suggestion_type`, `suggestion_count` |

### Tool Executions
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.tool_called` | Generic tool invocation | `tool_name`, `parameters` |
| `cdesk.tool_completed` | Tool execution finished | `tool_name`, `duration_ms`, `success` |
| `cdesk.tool_failed` | Tool execution error | `tool_name`, `error_type`, `error_message` |

### SQL Operations
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.sql_executed` | SQL query submitted | `template`, `warehouse`, `estimated_bytes` |
| `cdesk.sql_completed` | Query finished | `rows_returned`, `bytes_scanned`, `duration_ms` |
| `cdesk.sql_failed` | Query error | `error_code`, `error_message` |
| `cdesk.sql_cancelled` | Query cancelled | `reason`, `elapsed_ms` |
| `cdesk.sql_sampled` | Results sampled due to size | `original_rows`, `sampled_rows`, `sample_rate` |

### File Operations
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.file_read` | File accessed | `file_path`, `size_bytes`, `file_type` |
| `cdesk.file_written` | File created/modified | `file_path`, `size_bytes`, `operation` |
| `cdesk.file_deleted` | File removed | `file_path` |

### Memory & Insights
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.insight_recorded` | Insight atom created | `atom_id`, `subject`, `metric`, `value`, `provenance_query_hash` |
| `cdesk.insight_retrieved` | Insight recalled | `atom_ids`, `age_ms` |
| `cdesk.context_refreshed` | Context cache updated | `metrics_count`, `duration_ms` |
| `cdesk.context_loaded` | Context retrieved | `cache_hit`, `latency_ms` |

### Artifacts & Rendering
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.artifact_created` | Large result stored | `artifact_id`, `size_bytes`, `row_count`, `s3_url` |
| `cdesk.artifact_retrieved` | Artifact accessed | `artifact_id`, `cache_hit` |
| `cdesk.card_rendered` | Insight card shown | `card_type`, `render_ms` |
| `cdesk.link_generated` | Renderer link created | `link_type`, `expires_at` |

### Error Handling
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.error_encountered` | Any error occurred | `error_type`, `error_code`, `error_message`, `stack_trace` |
| `cdesk.retry_attempted` | Operation retried | `operation`, `attempt_number`, `backoff_ms` |
| `cdesk.fallback_triggered` | Degraded mode activated | `fallback_type`, `reason` |
| `cdesk.timeout_occurred` | Operation timed out | `operation`, `timeout_ms` |

### Performance & Monitoring
| Activity | Description | Feature JSON Fields |
|----------|-------------|-------------------|
| `cdesk.latency_exceeded` | SLO breach detected | `metric`, `target_ms`, `actual_ms` |
| `cdesk.queue_overflow` | Backpressure applied | `queue_depth`, `dropped_count` |
| `cdesk.cache_miss` | Cache lookup failed | `cache_type`, `key` |
| `cdesk.credit_warning` | Cost threshold reached | `credits_used`, `threshold`, `period` |

## Validation Rules

### Required Patterns
1. **Must start with `cdesk.`** - No exceptions
2. **Lowercase only** - `cdesk.User_Asked` ❌ → `cdesk.user_asked` ✅
3. **Underscore separation** - `cdesk.userAsked` ❌ → `cdesk.user_asked` ✅
4. **Present tense verbs** - `cdesk.asked_user` ❌ → `cdesk.user_asked` ✅
5. **Singular nouns** - `cdesk.files_read` ❌ → `cdesk.file_read` ✅

### Examples of Valid Activities
```
cdesk.session_started
cdesk.user_asked
cdesk.sql_executed
cdesk.insight_recorded
cdesk.error_encountered
```

### Examples of Invalid Activities
```
session_started         # Missing namespace
cdesk.SessionStarted    # Wrong case
claude.session_started  # Wrong namespace
cdesk.start_session    # Wrong verb form
cdesk.sessions_started  # Plural noun
```

## Implementation in Code

### TypeScript Enum
```typescript
export enum CdeskActivity {
  // Session
  SESSION_STARTED = 'cdesk.session_started',
  SESSION_ENDED = 'cdesk.session_ended',
  
  // User
  USER_ASKED = 'cdesk.user_asked',
  USER_CANCELLED = 'cdesk.user_cancelled',
  
  // Claude
  CLAUDE_RESPONDED = 'cdesk.claude_responded',
  
  // SQL
  SQL_EXECUTED = 'cdesk.sql_executed',
  SQL_COMPLETED = 'cdesk.sql_completed',
  
  // Insights
  INSIGHT_RECORDED = 'cdesk.insight_recorded',
  CONTEXT_REFRESHED = 'cdesk.context_refreshed',
  
  // Errors
  ERROR_ENCOUNTERED = 'cdesk.error_encountered',
  RETRY_ATTEMPTED = 'cdesk.retry_attempted',
}
```

### Validation Function
```typescript
export function isValidCdeskActivity(activity: string): boolean {
  // Must start with cdesk.
  if (!activity.startsWith('cdesk.')) return false;
  
  // Must be lowercase
  if (activity !== activity.toLowerCase()) return false;
  
  // Must follow verb_noun pattern
  const parts = activity.split('.');
  if (parts.length !== 2) return false;
  
  const eventName = parts[1];
  if (!/^[a-z]+(_[a-z]+)+$/.test(eventName)) return false;
  
  return true;
}
```

## Feature JSON Standards

### Common Fields
These fields should be included in most activities:
- `duration_ms`: Operation duration in milliseconds
- `success`: Boolean success indicator
- `error_message`: Error description if failed
- `customer_id`: Customer identifier (if not in main field)
- `session_id`: Session identifier

### Token/Cost Fields
For LLM operations:
- `model`: Model identifier (e.g., 'claude-3-opus')
- `prompt_tokens`: Input token count
- `completion_tokens`: Output token count
- `total_tokens`: Combined token count
- `cost_usd`: Estimated cost in USD

### SQL Fields
For database operations:
- `warehouse`: Compute warehouse used
- `template`: SafeSQL template name
- `rows_returned`: Result row count
- `bytes_scanned`: Data volume processed
- `credits_used`: Snowflake credits consumed

## Migration Guide

### From Old to New Format
| Old Activity | New Activity |
|--------------|--------------|
| `user_query` | `cdesk.user_asked` |
| `ai_response` | `cdesk.claude_responded` |
| `query_executed` | `cdesk.sql_executed` |
| `insight_saved` | `cdesk.insight_recorded` |
| `error` | `cdesk.error_encountered` |

### Backward Compatibility
During migration, the system can auto-prefix activities:
```typescript
function ensureCdeskNamespace(activity: string): string {
  return activity.startsWith('cdesk.') ? activity : `cdesk.${activity}`;
}
```

## Monitoring & Alerting

### Activity Volume Alerts
Set alerts for unusual activity patterns:
- Spike in `cdesk.error_encountered`
- Drop in `cdesk.user_asked`
- Increase in `cdesk.timeout_occurred`

### Performance Tracking
Monitor latency by activity:
- `cdesk.context_loaded` should be < 25ms p95
- `cdesk.claude_responded` should have first token < 300ms
- `cdesk.sql_completed` should track against estimates

## Future Extensions

Reserved for potential future activities:
- `cdesk.model_switched` - Model selection changed
- `cdesk.cost_estimated` - Pre-execution cost calculation
- `cdesk.permission_checked` - Access control validation
- `cdesk.audit_logged` - Compliance event recorded

These should follow the same naming conventions when implemented.