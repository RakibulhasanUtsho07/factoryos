import { DatabaseService } from '../database/database.service';
export declare class HealthController {
    private readonly database;
    constructor(database: DatabaseService);
    check(): Promise<{
        status: string;
        service: string;
        database: string;
        timestamp: string;
        responseTimeMs: number;
    }>;
}
