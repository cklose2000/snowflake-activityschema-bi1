/**
 * Generate a query tag for Snowflake queries following the format: cdesk_[longUuid]
 * This tag is used for:
 * 1. Setting _query_tag field in the events table
 * 2. Setting Snowflake's QUERY_TAG session parameter
 * 3. Joining with QUERY_HISTORY for SQL metrics
 *
 * Uses 16 characters to avoid collision risk (birthday paradox at ~4.3B queries vs ~77K with 8 chars)
 *
 * @returns Query tag in format "cdesk_a1b2c3d4e5f6g7h8"
 */
export declare function generateQueryTag(): string;
/**
 * Extract the UUID from a query tag
 * @param queryTag The full query tag (e.g., "cdesk_a1b2c3d4e5f6g7h8")
 * @returns The UUID portion (e.g., "a1b2c3d4e5f6g7h8")
 */
export declare function extractUuid(queryTag: string): string;
/**
 * Legacy function for backward compatibility
 * @deprecated Use extractUuid instead
 */
export declare function extractShortUuid(queryTag: string): string;
/**
 * Validate if a query tag follows the correct format
 * @param queryTag The query tag to validate
 * @returns True if valid format (supports both 8 and 16 char UUIDs for compatibility)
 */
export declare function isValidQueryTag(queryTag: string): boolean;
//# sourceMappingURL=query-tag.d.ts.map