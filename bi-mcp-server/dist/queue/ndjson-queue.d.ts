export interface QueueEvent {
    activity_id?: string;
    activity: string;
    customer: string;
    ts?: string;
    link?: string;
    revenue_impact?: number;
    feature_json?: Record<string, any>;
    session_id?: string;
    query_tag?: string;
}
export declare class NDJSONQueue {
    private stream;
    private currentPath;
    private baseDir;
    private currentSize;
    private eventCount;
    private rotationTimer;
    private readonly maxSize;
    private readonly maxAge;
    private readonly maxEvents;
    private isRotating;
    private writeBuffer;
    private flushTimer;
    constructor(basePath: string, maxSize?: number, // 16MB
    maxAge?: number, // 60s
    maxEvents?: number);
    initialize(): Promise<void>;
    private generateFilePath;
    private openStream;
    private scheduleRotation;
    rotate(): Promise<string | null>;
    write(event: QueueEvent): Promise<void>;
    private flush;
    close(): Promise<void>;
    getStats(): {
        currentPath: string;
        currentSize: number;
        eventCount: number;
        bufferLength: number;
    };
}
//# sourceMappingURL=ndjson-queue.d.ts.map