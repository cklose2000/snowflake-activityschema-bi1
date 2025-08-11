/**
 * Generate a query tag for Snowflake queries following the format: cdesk_[shortUuid]
 * This tag is used for:
 * 1. Setting _query_tag field in the events table
 * 2. Setting Snowflake's QUERY_TAG session parameter
 * 3. Joining with QUERY_HISTORY for SQL metrics
 *
 * @returns Query tag in format "cdesk_a1b2c3d4"
 */
export declare function generateQueryTag(): string;
/**
 * Extract the short UUID from a query tag
 * @param queryTag The full query tag (e.g., "cdesk_a1b2c3d4")
 * @returns The short UUID portion (e.g., "a1b2c3d4")
 */
export declare function extractShortUuid(queryTag: string): string;
/**
 * Validate if a query tag follows the correct format
 * @param queryTag The query tag to validate
 * @returns True if valid format
 */
export declare function isValidQueryTag(queryTag: string): boolean;
//# sourceMappingURL=query-tag.d.ts.map