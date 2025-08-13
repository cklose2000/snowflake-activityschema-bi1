export declare enum TicketStatus {
    PENDING = "pending",
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed",
    CANCELLED = "cancelled"
}
export interface QueryTicket {
    ticket_id: string;
    status: TicketStatus;
    template: string;
    params: any[];
    query_tag?: string;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    result?: any;
    error?: string;
    progress?: number;
    byte_count?: number;
    byte_cap?: number;
}
export declare class TicketManager {
    private tickets;
    private queue;
    private processing;
    private maxConcurrent;
    private activeQueries;
    private snowflakeClient;
    constructor(maxConcurrent?: number);
    setSnowflakeClient(client: any): void;
    createTicket(options: {
        template: string;
        params: any[];
        byte_cap?: number;
    }): {
        id: string;
        status: TicketStatus;
    };
    updateStatus(ticketId: string, status: string, result?: any): void;
    getTicket(ticketId: string): QueryTicket | null;
    updateTicket(ticketId: string, updates: Partial<QueryTicket>): void;
    cancelTicket(ticketId: string): boolean;
    private processQueue;
    private executeQuery;
    private cleanupOldTickets;
    getStats(): {
        pending: number;
        running: number;
        completed: number;
        failed: number;
        cancelled: number;
        total: number;
        queueLength: number;
        activeQueries: number;
    };
}
//# sourceMappingURL=ticket-manager.d.ts.map