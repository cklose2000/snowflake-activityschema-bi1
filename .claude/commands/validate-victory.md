# Automatic Victory Validation Command

## Purpose
Automatically validate any claims of success, completion, or achievement using the victory-auditor and chaos-tester agents.

## Usage
```bash
claude validate-victory
```

Or target specific claims:
```bash
claude validate-victory --claim "0.525ms p95 latency"
claude validate-victory --claim "100% ActivitySchema compliant"
claude validate-victory --claim "Production ready"
```

## Automatic Triggers

This command is AUTOMATICALLY invoked when detecting:
- ✅ (checkmarks)
- "Complete!" or "Successfully"
- "100%" anything
- "Ready for production"
- Performance claims (e.g., "p95 < 25ms")
- "All tests passing"
- "Fully compliant"

## Validation Process

1. **Parse Claims**: Extract all victory declarations from recent output
2. **Invoke victory-auditor**: Challenge each claim with evidence requests
3. **Run Tests**: Execute specific tests to verify claims
4. **Load Test**: For performance claims, run under load
5. **Chaos Test**: For "production ready" claims, run chaos-tester
6. **Generate Report**: Provide verification status for each claim

## Example Validation Flow

```bash
# Developer claims: "✅ Integration complete! 0.525ms p95 latency achieved!"

# Step 1: victory-auditor challenges
> Show me the integration test results
> Run 10,000 requests to verify p95 latency
> What about under load conditions?

# Step 2: Run actual tests
> npm run test:integration
> for i in {1..10000}; do curl http://localhost:3000/context/test; done
> calculate percentiles from response times

# Step 3: Report results
🔴 VICTORY AUDIT RESULTS
Claims: 1 checkmark, 1 performance claim
Verified: 0
Unsubstantiated: 1 (integration claim lacks test evidence)
Failed: 1 (latency is 47ms p95 under load, not 0.525ms)
```

## Validation Levels

### Level 1: Quick Check
- Run existing tests
- Check for obvious failures
- Verify basic claims

### Level 2: Thorough Validation  
- Run load tests
- Check edge cases
- Verify under adverse conditions

### Level 3: Production Certification
- Run full chaos testing
- Verify all SLOs
- Check disaster recovery

## Integration with Git Hooks

Add to `.git/hooks/pre-commit`:
```bash
#!/bin/bash
if git diff --cached | grep -E "✅|[Cc]omplete|100%|[Ss]uccessful"; then
  echo "Victory claims detected. Running validation..."
  claude validate-victory
  if [ $? -ne 0 ]; then
    echo "Validation failed. Please verify claims before committing."
    exit 1
  fi
fi
```

## Configuration Options

Create `.claude/validation-config.json`:
```json
{
  "autoValidate": true,
  "validationLevel": 2,
  "triggers": {
    "checkmarks": true,
    "percentages": true,
    "completeWords": true,
    "performanceClaims": true
  },
  "thresholds": {
    "performanceVariance": 0.1,  // 10% variance allowed
    "minimumTests": 1000,         // Min requests for p95 claims
    "chaosLevel": 3               // For "production ready"
  }
}
```

## Common Validations

### Performance Claims
```bash
# Claim: "< 25ms p95 latency"
# Validation:
time for i in {1..1000}; do 
  curl -w "%{time_total}\n" -o /dev/null -s http://localhost:3000/api
done | sort -n | awk 'NR==int(0.95*NR){print $1*1000 "ms"}'
```

### Completeness Claims
```bash
# Claim: "All tests passing"
# Validation:
npm test -- --coverage
if [ $(npm test 2>&1 | grep -c "FAIL") -gt 0 ]; then
  echo "Tests are NOT all passing"
fi
```

### Compliance Claims
```bash
# Claim: "100% ActivitySchema compliant"
# Validation:
node scripts/compliance-check.js
grep -r "activity" src/ | grep -v "cdesk\."  # Find non-compliant activities
```

## Failure Handling

When validation fails:
1. Block the commit/merge
2. Generate detailed failure report
3. Provide specific steps to fix
4. Suggest appropriate claim language

Example:
```
VALIDATION FAILED: "0.525ms p95 latency"
Reality: 47ms p95 under load
Suggestion: "0.525ms median latency in development environment"
To fix: Implement caching, optimize queries, or adjust claim
```

## Meta-Validation

Periodically run meta-auditor to ensure this validation isn't:
- Too strict (blocking all progress)
- Too lenient (letting false claims through)
- Inconsistent (different standards at different times)

```bash
claude meta-audit --target victory-auditor --period 7d
```

## Philosophy

**"Trust, but verify"**

This isn't about being negative or blocking progress. It's about:
- Building confidence in our claims
- Catching issues before production
- Maintaining professional standards
- Creating a culture of evidence-based development

Better to have validation catch an issue than a customer.