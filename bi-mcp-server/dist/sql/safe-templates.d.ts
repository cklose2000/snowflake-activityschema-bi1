export interface SQLTemplate {
    sql: string;
    validator: (params: any[]) => any[];
}
export declare const SAFE_TEMPLATES: Map<string, SQLTemplate>;
export declare function generateQueryHash(template: string, params: any): string;
export declare function executeSafeSQL(connection: any, // Snowflake connection
templateName: string, params: any[], options?: {
    timeout?: number;
    queryTag?: string;
}): Promise<any>;
export declare function validateAllTemplates(): void;
export declare const TEMPLATE_NAMES: {
    readonly LOG_EVENT: "LOG_EVENT";
    readonly LOG_INSIGHT: "LOG_INSIGHT";
    readonly GET_CONTEXT: "GET_CONTEXT";
    readonly UPDATE_CONTEXT: "UPDATE_CONTEXT";
    readonly GET_RECENT_ACTIVITIES: "GET_RECENT_ACTIVITIES";
    readonly GET_ACTIVITY_STATS: "GET_ACTIVITY_STATS";
    readonly CHECK_HEALTH: "CHECK_HEALTH";
};
//# sourceMappingURL=safe-templates.d.ts.map