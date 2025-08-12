import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
const logger = pino.default({ name: 'ticket-manager' });
export var TicketStatus;
(function (TicketStatus) {
    TicketStatus["PENDING"] = "pending";
    TicketStatus["RUNNING"] = "running";
    TicketStatus["COMPLETED"] = "completed";
    TicketStatus["FAILED"] = "failed";
    TicketStatus["CANCELLED"] = "cancelled";
})(TicketStatus || (TicketStatus = {}));
export class TicketManager {
    tickets = new Map();
    queue = [];
    processing = false;
    maxConcurrent = 5;
    activeQueries = 0;
    constructor(maxConcurrent = 5) {
        this.maxConcurrent = maxConcurrent;
        // Clean up old tickets periodically
        setInterval(() => {
            this.cleanupOldTickets();
        }, 60000); // Every minute
    }
    createTicket(options) {
        const ticketId = uuidv4();
        const ticket = {
            ticket_id: ticketId,
            status: TicketStatus.PENDING,
            template: options.template,
            params: options.params,
            created_at: new Date().toISOString(),
            byte_cap: options.byte_cap,
        };
        this.tickets.set(ticketId, ticket);
        this.queue.push(ticketId);
        logger.info({ ticketId, template: options.template }, 'Created query ticket');
        // Start processing if not already running
        if (!this.processing) {
            this.processQueue().catch(err => {
                logger.error({ err }, 'Queue processing error');
            });
        }
        return { id: ticketId, status: TicketStatus.PENDING };
    }
    updateStatus(ticketId, status, result) {
        const ticket = this.tickets.get(ticketId);
        if (ticket) {
            ticket.status = status;
            if (result) {
                if (result.error) {
                    ticket.error = result.error;
                }
                else {
                    ticket.result = result;
                }
            }
            if (status === 'completed' || status === 'failed') {
                ticket.completed_at = new Date().toISOString();
                this.activeQueries--;
            }
        }
    }
    getTicket(ticketId) {
        return this.tickets.get(ticketId) || null;
    }
    updateTicket(ticketId, updates) {
        const ticket = this.tickets.get(ticketId);
        if (ticket) {
            Object.assign(ticket, updates);
            if (updates.status === TicketStatus.COMPLETED ||
                updates.status === TicketStatus.FAILED) {
                ticket.completed_at = new Date().toISOString();
                this.activeQueries--;
            }
        }
    }
    cancelTicket(ticketId) {
        const ticket = this.tickets.get(ticketId);
        if (ticket && ticket.status === TicketStatus.PENDING) {
            ticket.status = TicketStatus.CANCELLED;
            // Remove from queue
            const index = this.queue.indexOf(ticketId);
            if (index > -1) {
                this.queue.splice(index, 1);
            }
            return true;
        }
        return false;
    }
    async processQueue() {
        if (this.processing) {
            return;
        }
        this.processing = true;
        try {
            while (this.queue.length > 0 && this.activeQueries < this.maxConcurrent) {
                const ticketId = this.queue.shift();
                if (!ticketId)
                    continue;
                const ticket = this.tickets.get(ticketId);
                if (!ticket || ticket.status !== TicketStatus.PENDING) {
                    continue;
                }
                // Mark as running
                ticket.status = TicketStatus.RUNNING;
                ticket.started_at = new Date().toISOString();
                this.activeQueries++;
                // Execute query async (would be implemented with actual Snowflake connection)
                this.executeQuery(ticket).catch(err => {
                    logger.error({ err, ticketId }, 'Query execution error');
                    this.updateTicket(ticketId, {
                        status: TicketStatus.FAILED,
                        error: err.message,
                    });
                });
            }
        }
        finally {
            this.processing = false;
            // Schedule next processing if queue not empty
            if (this.queue.length > 0) {
                setTimeout(() => {
                    this.processQueue().catch(err => {
                        logger.error({ err }, 'Queue processing error');
                    });
                }, 100);
            }
        }
    }
    async executeQuery(ticket) {
        // This would execute the actual query using SafeSQL templates
        // For now, this is a placeholder
        logger.info({ ticketId: ticket.ticket_id }, 'Executing query');
        // Simulate query execution
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Update ticket with results
        this.updateTicket(ticket.ticket_id, {
            status: TicketStatus.COMPLETED,
            result: { rows: [], rowCount: 0 },
            progress: 100,
        });
    }
    cleanupOldTickets() {
        const cutoffTime = Date.now() - 3600000; // 1 hour
        for (const [ticketId, ticket] of this.tickets) {
            const ticketTime = new Date(ticket.created_at).getTime();
            if (ticketTime < cutoffTime &&
                (ticket.status === TicketStatus.COMPLETED ||
                    ticket.status === TicketStatus.FAILED ||
                    ticket.status === TicketStatus.CANCELLED)) {
                this.tickets.delete(ticketId);
            }
        }
    }
    getStats() {
        const statuses = {
            pending: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
        };
        for (const ticket of this.tickets.values()) {
            statuses[ticket.status]++;
        }
        return {
            total: this.tickets.size,
            queueLength: this.queue.length,
            activeQueries: this.activeQueries,
            ...statuses,
        };
    }
}
//# sourceMappingURL=ticket-manager.js.map