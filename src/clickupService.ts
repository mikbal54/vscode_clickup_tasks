import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';

export interface ClickUpTask {
    id: string;
    name: string;
    status: {
        status: string;
        color: string;
        type?: string; // Status type: "open", "custom", "closed", etc.
        orderindex?: number;
    };
    url: string;
    assignees: Array<{
        id: string | number;
        username?: string;
        user?: {
            id: string | number;
        };
        user_id?: string | number;
    }>;
    due_date?: string;
    priority?: {
        priority: string;
        color: string;
    };
    list?: {
        id: string;
        name: string;
    };
    space?: {
        id: string;
        name: string;
    };
    timeTracked?: number; // Total time tracked in milliseconds
    time_estimate?: number; // Time estimate in milliseconds
    isCurrentlyTracked?: boolean; // Whether this task is currently being time-tracked
}

export class ClickUpService {
    private apiClient: AxiosInstance | null = null;
    private currentUserId: string | null = null;
    private outputChannel: vscode.OutputChannel | undefined;
    // Internal timer tracking: stores taskId -> start timestamp (milliseconds)
    private internalTimerStartTimes: Map<string, number> = new Map();

    constructor(outputChannel?: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    private log(message: string) {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
        }
        console.log(message);
    }

    private getApiClient(): AxiosInstance | null {
        const config = vscode.workspace.getConfiguration('clickupTasks');
        // Try to get API token from config first, then from environment variable
        let apiToken = config.get<string>('apiToken', '');
        
        if (!apiToken) {
            // Fallback to environment variable (for development/debugging)
            apiToken = process.env.CLICKUP_API_KEY || process.env.CLICKUP_API_TOKEN || '';
        }

        if (!apiToken) {
            return null;
        }

        if (!this.apiClient || this.apiClient.defaults.headers.common['Authorization'] !== apiToken) {
            this.apiClient = axios.create({
                baseURL: 'https://api.clickup.com/api/v2',
                headers: {
                    'Authorization': apiToken,
                    'Content-Type': 'application/json'
                }
            });
            // Reset user ID when API client changes
            this.currentUserId = null;
        }

        return this.apiClient;
    }

    private async getCurrentUserId(client: AxiosInstance): Promise<string> {
        if (this.currentUserId) {
            return this.currentUserId;
        }

        try {
            const response = await client.get('/user');
            const userId = response.data.user.id;
            // Ensure userId is always a string for consistent comparison
            this.currentUserId = String(userId);
            return this.currentUserId;
        } catch (error: any) {
            throw new Error(`Failed to get current user: ${error.response?.data?.err || error.message}`);
        }
    }

    async debugListAllMyTasks(): Promise<void> {
        const client = this.getApiClient();
        if (!client) {
            throw new Error('ClickUp API token not configured. Please configure it in settings.');
        }

        try {
            // Get current user ID
            const currentUserId = await this.getCurrentUserId(client);
            this.log(`\n=== DEBUG: Listing ALL tasks where you are in assignees list ===`);
            this.log(`Current user ID: ${currentUserId}`);

            // Get teams
            const teamsResponse = await client.get('/team');
            const teams = teamsResponse.data.teams;
            const targetTeamId = teams[0].id;
            this.log(`Using team: ${targetTeamId}`);

            // Try team-level filtered tasks endpoint first (more efficient)
            this.log(`\nTrying team-level filtered tasks endpoint...`);
            try {
                const teamTasksResponse = await client.get(`/team/${targetTeamId}/task`, {
                    params: {
                        assignees: [currentUserId],
                        include_closed: false,
                        subtasks: false,
                        page: 0
                    },
                    paramsSerializer: (params: any) => {
                        const searchParams = new URLSearchParams();
                        Object.keys(params).forEach(key => {
                            const value = params[key];
                            if (Array.isArray(value)) {
                                value.forEach(v => searchParams.append(`${key}[]`, String(v)));
                            } else {
                                searchParams.append(key, String(value));
                            }
                        });
                        return searchParams.toString();
                    }
                });
                
                const teamTasks = teamTasksResponse.data.tasks || [];
                this.log(`Team-level endpoint returned ${teamTasks.length} tasks (page 0)`);
                
                // If this works, we could use it, but let's continue with list-by-list for completeness
            } catch (err: any) {
                this.log(`Team-level endpoint not available or error: ${err.message}`);
            }

            // Get spaces
            const spacesResponse = await client.get(`/team/${targetTeamId}/space`);
            const spaces = spacesResponse.data.spaces || [];
            this.log(`Found ${spaces.length} spaces\n`);

            const allMyTasks: Array<{task: any, listName: string, spaceName: string}> = [];
            const taskIdsSeen = new Set<string>(); // Track task IDs to avoid duplicates

            // Check ALL spaces, folders, and lists
            for (const space of spaces) {
                try {
                    // Get folders in the space
                    const foldersResponse = await client.get(`/space/${space.id}/folder`);
                    const folders = foldersResponse.data.folders || [];
                    
                    // Check ALL folders
                    for (const folder of folders) {
                        const listsResponse = await client.get(`/folder/${folder.id}/list`);
                        const lists = listsResponse.data.lists || [];
                        
                        // Check ALL lists in folder
                        for (const list of lists) {
                            // Get ALL tasks from this list (no assignee filter)
                            let page = 0;
                            let hasMore = true;
                            const pageSize = 100;
                            
                            while (hasMore) {
                                try {
                                    const tasksResponse = await client.get(`/list/${list.id}/task`, {
                                        params: {
                                            include_closed: true,  // Include closed tasks too
                                            subtasks: false,
                                            include_timl: true,  // Include tasks that exist in multiple lists
                                            page: page
                                        }
                                    });
                                    
                                    const tasks = tasksResponse.data.tasks || [];
                                    this.log(`    List "${list.name}": Fetched ${tasks.length} tasks (page ${page + 1})`);
                                    
                                    // Filter tasks where current user is in assignees
                                    let tasksAssignedToMe = 0;
                                    tasks.forEach((task: any) => {
                                        const assigneeIds = (task.assignees || []).map((assignee: any) => {
                                            return String(assignee.id || assignee.user?.id || assignee.user_id || '');
                                        });
                                        
                                        if (assigneeIds.includes(currentUserId)) {
                                            // Avoid duplicates (tasks can appear in multiple lists)
                                            if (!taskIdsSeen.has(task.id)) {
                                                taskIdsSeen.add(task.id);
                                                allMyTasks.push({
                                                    task: task,
                                                    listName: list.name,
                                                    spaceName: space.name
                                                });
                                                tasksAssignedToMe++;
                                            }
                                        }
                                    });
                                    
                                    if (tasksAssignedToMe > 0) {
                                        this.log(`      → Found ${tasksAssignedToMe} tasks assigned to you in this page`);
                                    }
                                    
                                    hasMore = tasks.length === pageSize;
                                    page++;
                                    
                                    if (page > 100) break;
                                } catch (err: any) {
                                    this.log(`Error fetching tasks from list ${list.id}: ${err.message}`);
                                    break;
                                }
                            }
                        }
                    }
                    
                    // Also check ALL folderless lists
                    const spaceListsResponse = await client.get(`/space/${space.id}/list`);
                    const spaceLists = spaceListsResponse.data.lists || [];
                    
                    for (const list of spaceLists) {
                        let page = 0;
                        let hasMore = true;
                        const pageSize = 100;
                        
                        while (hasMore) {
                            try {
                                const tasksResponse = await client.get(`/list/${list.id}/task`, {
                                    params: {
                                        include_closed: false,
                                        subtasks: false,
                                        include_timl: true,  // Include tasks that exist in multiple lists
                                        page: page
                                    }
                                });
                                
                                const tasks = tasksResponse.data.tasks || [];
                                this.log(`    Folderless list "${list.name}": Fetched ${tasks.length} tasks (page ${page + 1})`);
                                
                                // Filter tasks where current user is in assignees
                                let tasksAssignedToMe = 0;
                                tasks.forEach((task: any) => {
                                    const assigneeIds = (task.assignees || []).map((assignee: any) => {
                                        return String(assignee.id || assignee.user?.id || assignee.user_id || '');
                                    });
                                    
                                    if (assigneeIds.includes(currentUserId)) {
                                        // Avoid duplicates (tasks can appear in multiple lists)
                                        if (!taskIdsSeen.has(task.id)) {
                                            taskIdsSeen.add(task.id);
                                            allMyTasks.push({
                                                task: task,
                                                listName: list.name,
                                                spaceName: space.name
                                            });
                                            tasksAssignedToMe++;
                                        }
                                    }
                                });
                                
                                if (tasksAssignedToMe > 0) {
                                    this.log(`      → Found ${tasksAssignedToMe} tasks assigned to you in this page`);
                                }
                                
                                hasMore = tasks.length === pageSize;
                                page++;
                                
                                if (page > 100) break;
                            } catch (err: any) {
                                this.log(`Error fetching tasks from list ${list.id}: ${err.message}`);
                                break;
                            }
                        }
                    }
                } catch (error: any) {
                    this.log(`Error inspecting space ${space.id}: ${error.message}`);
                }
            }
            
            // Display results
            this.log(`\n=== RESULTS ===`);
            this.log(`Total tasks where you are in assignees list: ${allMyTasks.length}\n`);
            
            // Group by status
            const tasksByStatus = new Map<string, typeof allMyTasks>();
            allMyTasks.forEach(({task, listName, spaceName}) => {
                const status = task.status?.status || 'Unknown';
                if (!tasksByStatus.has(status)) {
                    tasksByStatus.set(status, []);
                }
                tasksByStatus.get(status)!.push({task, listName, spaceName});
            });
            
            // Display grouped by status
            this.log(`Tasks grouped by status:\n`);
            const sortedStatuses = Array.from(tasksByStatus.keys()).sort();
            sortedStatuses.forEach(status => {
                const tasks = tasksByStatus.get(status)!;
                this.log(`"${status}": ${tasks.length} task(s)`);
                tasks.forEach(({task, listName, spaceName}) => {
                    const assignees = (task.assignees || []).map((a: any) => a.username || a.id).join(', ');
                    this.log(`  - "${task.name}"`);
                    this.log(`    List: ${listName} | Space: ${spaceName}`);
                    this.log(`    Assignees: ${assignees}`);
                    this.log(`    ID: ${task.id}`);
                });
                this.log('');
            });
            
            // Summary by status
            this.log(`\n=== SUMMARY ===`);
            this.log(`Total tasks: ${allMyTasks.length}`);
            sortedStatuses.forEach(status => {
                const count = tasksByStatus.get(status)!.length;
                this.log(`  "${status}": ${count}`);
            });
            
        } catch (error: any) {
            this.log(`DEBUG Error: ${error.message}`);
            if (error.response) {
                this.log(`Response status: ${error.response.status}`);
                this.log(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
            }
        }
    }

    async debugFetchRawTasks(): Promise<void> {
        const client = this.getApiClient();
        if (!client) {
            throw new Error('ClickUp API token not configured. Please configure it in settings.');
        }

        try {
            // Get current user ID
            const currentUserId = await this.getCurrentUserId(client);
            this.log(`\n=== DEBUG: Fetching raw task data ===`);
            this.log(`Current user ID: ${currentUserId}`);

            // Get teams
            const teamsResponse = await client.get('/team');
            const teams = teamsResponse.data.teams;
            const targetTeamId = teams[0].id;
            this.log(`Using team: ${targetTeamId}`);

            // Get spaces
            const spacesResponse = await client.get(`/team/${targetTeamId}/space`);
            const spaces = spacesResponse.data.spaces || [];
            this.log(`Found ${spaces.length} spaces`);

            // Check ALL spaces, folders, and lists
            const allStatuses = new Set<string>();
            const allTasksAssignedToMe: any[] = [];
            
            for (const space of spaces) { // Check ALL spaces
                try {
                    this.log(`\n=== Space: ${space.name} (${space.id}) ===`);
                    
                    // Get folders in the space
                    const foldersResponse = await client.get(`/space/${space.id}/folder`);
                    const folders = foldersResponse.data.folders || [];
                    
                    // Check ALL folders
                    for (const folder of folders) {
                        this.log(`\n  Folder: ${folder.name} (${folder.id})`);
                        const listsResponse = await client.get(`/folder/${folder.id}/list`);
                        const lists = listsResponse.data.lists || [];
                        
                        // Check ALL lists in folder
                        for (const list of lists) {
                            this.log(`\n    List: ${list.name} (${list.id})`);
                            
                            // Get list details to see available statuses
                            try {
                                const listDetailsResponse = await client.get(`/list/${list.id}`);
                                const listDetails = listDetailsResponse.data;
                                if (listDetails.statuses) {
                                    this.log(`    Available statuses:`);
                                    listDetails.statuses.forEach((status: any) => {
                                        const statusName = status.status;
                                        allStatuses.add(statusName);
                                        this.log(`      - "${statusName}" (type: ${status.type}, order: ${status.orderindex})`);
                                    });
                                }
                            } catch (err: any) {
                                this.log(`    Error getting list details: ${err.message}`);
                            }
                            
                            // Get tasks with assignee filter (with pagination)
                            try {
                                let page = 0;
                                let hasMore = true;
                                const pageSize = 100;
                                
                                while (hasMore) {
                                    const tasksResponse = await client.get(`/list/${list.id}/task`, {
                                        params: {
                                            assignees: [currentUserId],
                                            include_closed: false,
                                            subtasks: false,
                                            include_timl: true,  // Include tasks that exist in multiple lists
                                            page: page
                                        },
                                        paramsSerializer: (params: any) => {
                                            const searchParams = new URLSearchParams();
                                            Object.keys(params).forEach(key => {
                                                const value = params[key];
                                                if (Array.isArray(value)) {
                                                    value.forEach(v => searchParams.append(`${key}[]`, String(v)));
                                                } else {
                                                    searchParams.append(key, String(value));
                                                }
                                            });
                                            return searchParams.toString();
                                        }
                                    });
                                    
                                    const tasks = tasksResponse.data.tasks || [];
                                    allTasksAssignedToMe.push(...tasks);
                                    
                                    this.log(`    Found ${tasks.length} tasks assigned to you (page ${page + 1})`);
                                    tasks.forEach((task: any) => {
                                        this.log(`      - "${task.name}" - Status: "${task.status?.status}"`);
                                    });
                                    
                                    hasMore = tasks.length === pageSize;
                                    page++;
                                    
                                    if (page > 100) break; // Safety limit
                                }
                            } catch (err: any) {
                                this.log(`    Error fetching tasks: ${err.message}`);
                            }
                        }
                    }
                    
                    // Also check ALL folderless lists
                    const spaceListsResponse = await client.get(`/space/${space.id}/list`);
                    const spaceLists = spaceListsResponse.data.lists || [];
                    
                    if (spaceLists.length > 0) {
                        this.log(`\n  Folderless lists:`);
                        for (const list of spaceLists) {
                            this.log(`\n    List: ${list.name} (${list.id})`);
                            try {
                                const listDetailsResponse = await client.get(`/list/${list.id}`);
                                const listDetails = listDetailsResponse.data;
                                if (listDetails.statuses) {
                                    this.log(`    Available statuses:`);
                                    listDetails.statuses.forEach((status: any) => {
                                        const statusName = status.status;
                                        allStatuses.add(statusName);
                                        this.log(`      - "${statusName}" (type: ${status.type}, order: ${status.orderindex})`);
                                    });
                                }
                                
                                // Get tasks from folderless lists too
                                let page = 0;
                                let hasMore = true;
                                const pageSize = 100;
                                
                                while (hasMore) {
                                    const tasksResponse = await client.get(`/list/${list.id}/task`, {
                                        params: {
                                            assignees: [currentUserId],
                                            include_closed: false,
                                            subtasks: false,
                                            include_timl: true,  // Include tasks that exist in multiple lists
                                            page: page
                                        },
                                        paramsSerializer: (params: any) => {
                                            const searchParams = new URLSearchParams();
                                            Object.keys(params).forEach(key => {
                                                const value = params[key];
                                                if (Array.isArray(value)) {
                                                    value.forEach(v => searchParams.append(`${key}[]`, String(v)));
                                                } else {
                                                    searchParams.append(key, String(value));
                                                }
                                            });
                                            return searchParams.toString();
                                        }
                                    });
                                    
                                    const tasks = tasksResponse.data.tasks || [];
                                    allTasksAssignedToMe.push(...tasks);
                                    
                                    this.log(`    Found ${tasks.length} tasks assigned to you (page ${page + 1})`);
                                    tasks.forEach((task: any) => {
                                        this.log(`      - "${task.name}" - Status: "${task.status?.status}"`);
                                    });
                                    
                                    hasMore = tasks.length === pageSize;
                                    page++;
                                    
                                    if (page > 100) break;
                                }
                            } catch (err: any) {
                                this.log(`    Error: ${err.message}`);
                            }
                        }
                    }
                } catch (error: any) {
                    this.log(`Error inspecting space ${space.id}: ${error.message}`);
                }
            }
            
            // Summary
            this.log(`\n\n=== SUMMARY ===`);
            this.log(`Total unique statuses found across all lists: ${allStatuses.size}`);
            this.log(`All status names: [${Array.from(allStatuses).join(', ')}]`);
            this.log(`\nTotal tasks assigned to you: ${allTasksAssignedToMe.length}`);
            
            // Group tasks by status
            const tasksByStatus = new Map<string, any[]>();
            allTasksAssignedToMe.forEach(task => {
                const status = task.status?.status || 'Unknown';
                if (!tasksByStatus.has(status)) {
                    tasksByStatus.set(status, []);
                }
                tasksByStatus.get(status)!.push(task);
            });
            
            this.log(`\nTasks grouped by status:`);
            tasksByStatus.forEach((tasks, status) => {
                this.log(`  "${status}": ${tasks.length} tasks`);
                tasks.forEach(task => {
                    this.log(`    - "${task.name}"`);
                });
            });
        } catch (error: any) {
            this.log(`DEBUG Error: ${error.message}`);
            if (error.response) {
                this.log(`Response status: ${error.response.status}`);
                this.log(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
            }
        }
    }

    /**
     * Get the currently running time entry, if any
     * @returns The task ID of the currently tracked task, or null if none
     */
    private async getCurrentTimeEntryTaskId(client: AxiosInstance, teamId: string): Promise<string | null> {
        try {
            // Try ClickUp API endpoint to get current time entry
            // The endpoint might be /team/{team_id}/time_entries/current or similar
            const response = await client.get(`/team/${teamId}/time_entries/current`);
            
            // Handle different possible response structures
            const timeEntry = response.data?.data || response.data;
            
            if (timeEntry) {
                // Check various possible structures for task ID
                const taskId = timeEntry.task?.id || 
                             timeEntry.task_id || 
                             timeEntry.taskId;
                
                if (taskId) {
                    return String(taskId);
                }
            }
            return null;
        } catch (error: any) {
            // If there's no current time entry, the API returns 404 or similar
            // This is expected when no timer is running
            if (error.response?.status === 404 || error.response?.status === 400) {
                return null;
            }
            // Log other errors but don't fail the whole operation
            this.log(`Warning: Could not get current time entry: ${error.message}`);
            return null;
        }
    }

    /**
     * Start time tracking for a task
     * @param taskId The task ID to start tracking
     * @returns Promise that resolves when tracking starts
     */
    async startTimeTracking(taskId: string): Promise<void> {
        const client = this.getApiClient();
        if (!client) {
            throw new Error('ClickUp API token not configured. Please configure it in settings.');
        }

        try {
            // Get team ID
            const teamsResponse = await client.get('/team');
            const teams = teamsResponse.data.teams;
            
            if (!teams || teams.length === 0) {
                throw new Error('No teams found in your ClickUp account');
            }

            const config = vscode.workspace.getConfiguration('clickupTasks');
            const teamId = config.get<string>('teamId', '');
            const targetTeamId = teamId || teams[0].id;

            // ClickUp API endpoint to start time tracking
            // POST /team/{team_id}/time_entries/start
            // The request body should contain: { tid: task_id }
            await client.post(`/team/${targetTeamId}/time_entries/start`, {
                tid: taskId // task ID (required)
            });

            // Store internal timer start time
            this.internalTimerStartTimes.set(taskId, Date.now());
            this.log(`Started time tracking for task ${taskId}`);
        } catch (error: any) {
            if (error.response) {
                const errorMessage = error.response.data?.err || error.message;
                if (error.response.status === 400 && errorMessage.includes('already running')) {
                    // If there's already a timer running, stop it first and then start the new one
                    this.log(`Timer already running, stopping current timer first...`);
                    await this.stopTimeTracking();
                    // Retry starting the new timer
                    await this.startTimeTracking(taskId);
                    return;
                }
                throw new Error(`Failed to start time tracking: ${errorMessage}`);
            }
            throw error;
        }
    }

    /**
     * Get a single task by ID
     * @param taskId The task ID to fetch
     * @returns The task object or null if not found
     */
    async getTask(taskId: string): Promise<ClickUpTask | null> {
        const client = this.getApiClient();
        if (!client) {
            throw new Error('ClickUp API token not configured. Please configure it in settings.');
        }

        try {
            // Use ClickUp API Get Task endpoint: GET /task/{task_id}
            const response = await client.get(`/task/${taskId}`);
            const task = response.data;

            // Extract time_spent from task object (in milliseconds)
            let timeTracked = 0;
            if (task.time_spent !== undefined && task.time_spent !== null) {
                timeTracked = typeof task.time_spent === 'string' 
                    ? parseInt(task.time_spent, 10) || 0
                    : Number(task.time_spent) || 0;
            }

            // Extract space info if available
            let spaceInfo = undefined;
            if (task.space) {
                spaceInfo = {
                    id: task.space.id,
                    name: task.space.name
                };
            }

            return {
                ...task,
                space: spaceInfo,
                timeTracked
            };
        } catch (error: any) {
            if (error.response?.status === 404) {
                this.log(`Task ${taskId} not found`);
                return null;
            }
            throw error;
        }
    }

    /**
     * Stop the currently running time tracking
     * @returns Promise that resolves with the task ID that was being tracked, or null if none
     */
    async stopTimeTracking(): Promise<string | null> {
        const client = this.getApiClient();
        if (!client) {
            throw new Error('ClickUp API token not configured. Please configure it in settings.');
        }

        try {
            // Get team ID
            const teamsResponse = await client.get('/team');
            const teams = teamsResponse.data.teams;
            
            if (!teams || teams.length === 0) {
                throw new Error('No teams found in your ClickUp account');
            }

            const config = vscode.workspace.getConfiguration('clickupTasks');
            const teamId = config.get<string>('teamId', '');
            const targetTeamId = teamId || teams[0].id;

            // Get the currently tracked task ID BEFORE stopping (so we know which timer to clear)
            const currentlyTrackedTaskId = await this.getCurrentTimeEntryTaskId(client, targetTeamId);

            // ClickUp API endpoint to stop time tracking
            // POST /team/{team_id}/time_entries/stop
            await client.post(`/team/${targetTeamId}/time_entries/stop`);

            // Clear internal timer for the task that was being tracked
            // When stopping, ClickUp updates time_spent, so we reset our internal timer
            if (currentlyTrackedTaskId) {
                this.internalTimerStartTimes.delete(currentlyTrackedTaskId);
                this.log(`Stopped and cleared internal timer for task ${currentlyTrackedTaskId} (time_spent updated in ClickUp)`);
            } else if (this.internalTimerStartTimes.size > 0) {
                // Fallback: if we couldn't determine which task, clear all timers
                // This handles edge cases where the timer state is inconsistent
                this.internalTimerStartTimes.clear();
                this.log(`Stopped and cleared all internal timers (could not determine tracked task, time_spent updated)`);
            }

            this.log(`Stopped time tracking`);
            return currentlyTrackedTaskId;
        } catch (error: any) {
            if (error.response) {
                const errorMessage = error.response.data?.err || error.message;
                if (error.response.status === 400 || error.response.status === 404) {
                    // No timer running - this is okay, just log it
                    this.log(`No timer running to stop`);
                    return null;
                }
                throw new Error(`Failed to stop time tracking: ${errorMessage}`);
            }
            throw error;
        }
    }

    async getInProgressTasks(): Promise<ClickUpTask[]> {
        const client = this.getApiClient();
        if (!client) {
            throw new Error('ClickUp API token not configured. Please configure it in settings.');
        }

        try {
            // First, get the user's teams
            const teamsResponse = await client.get('/team');
            const teams = teamsResponse.data.teams;
            
            if (!teams || teams.length === 0) {
                throw new Error('No teams found in your ClickUp account');
            }

            const config = vscode.workspace.getConfiguration('clickupTasks');
            const teamId = config.get<string>('teamId', '');
            const targetTeamId = teamId || teams[0].id;

            // Get current user ID first (needed for filtering)
            const currentUserId = await this.getCurrentUserId(client);
            this.log(`Current user ID: ${currentUserId} (type: ${typeof currentUserId})`);

            // Get the currently tracked task ID, if any
            const currentlyTrackedTaskId = await this.getCurrentTimeEntryTaskId(client, targetTeamId);
            if (currentlyTrackedTaskId) {
                this.log(`Currently tracked task ID: ${currentlyTrackedTaskId}`);
            }

            // Get configured in-progress status names (default to common variations)
            const inProgressStatuses = config.get<string[]>('inProgressStatuses', [
                'in progress',
                'active',
                'working',
                'in-progress'
            ]).map(s => s.toLowerCase());
            this.log(`Looking for statuses: [${inProgressStatuses.join(', ')}]`);

            // Get all tasks for the team
            const tasks: ClickUpTask[] = [];
            
            // Get spaces for the team
            const spacesResponse = await client.get(`/team/${targetTeamId}/space`);
            const spaces = spacesResponse.data.spaces || [];

            for (const space of spaces) {
                try {
                    // Get folders in the space
                    const foldersResponse = await client.get(`/space/${space.id}/folder`);
                    const folders = foldersResponse.data.folders || [];

                    // Get lists from folders
                    for (const folder of folders) {
                        const listsResponse = await client.get(`/folder/${folder.id}/list`);
                        const lists = listsResponse.data.lists || [];

                        for (const list of lists) {
                            const listTasks = await this.getTasksFromList(client, list.id, space, currentUserId);
                            tasks.push(...listTasks);
                        }
                    }

                    // Get lists directly in space (not in folders)
                    const spaceListsResponse = await client.get(`/space/${space.id}/list`);
                    const spaceLists = spaceListsResponse.data.lists || [];

                    for (const list of spaceLists) {
                        const listTasks = await this.getTasksFromList(client, list.id, space, currentUserId);
                        tasks.push(...listTasks);
                    }
                } catch (error) {
                    console.error(`Error fetching tasks from space ${space.id}:`, error);
                }
            }

            // Filter tasks: assigned to current user AND status matches in-progress statuses
            // Note: We filter client-side to ensure we catch all tasks regardless of API filtering quirks
            const filteredTasks = tasks.filter(task => {
                // Check if task is assigned to current user
                // Handle different assignee object structures from API
                const assigneeIds = task.assignees?.map(assignee => {
                    // API might return assignee.id as number or string, or assignee.user.id
                    return String(assignee.id || assignee.user?.id || assignee.user_id || '');
                }) || [];
                
                const isAssignedToMe = assigneeIds.some(assigneeId => assigneeId === currentUserId);
                
                if (!isAssignedToMe) {
                    return false;
                }

                // Check if status matches any of the configured in-progress statuses (case-insensitive)
                // Handle different status object structures
                const statusValue = task.status?.status || task.status || '';
                const status = String(statusValue).toLowerCase().trim();
                const matches = inProgressStatuses.includes(status);
                
                return matches;
            });
            
            // Mark which task is currently being tracked
            if (currentlyTrackedTaskId) {
                const trackedTaskIdStr = String(currentlyTrackedTaskId);
                
                // Find the previously tracked task (if any) that is different from the current one
                // Only one task can be tracked at a time, so find any task in our map that's not the current one
                const previousTrackedTasks = Array.from(this.internalTimerStartTimes.keys())
                    .filter(id => String(id) !== trackedTaskIdStr);
                
                // If a different task was previously tracked, clear its timer
                // (ClickUp has updated time_spent for the previous task when tracking switched)
                if (previousTrackedTasks.length > 0) {
                    previousTrackedTasks.forEach(prevTaskId => {
                        this.internalTimerStartTimes.delete(prevTaskId);
                        this.log(`Cleared internal timer for previous task ${prevTaskId} (tracking switched to ${trackedTaskIdStr}, time_spent updated)`);
                    });
                }
                
                filteredTasks.forEach(task => {
                    const isTracked = String(task.id) === trackedTaskIdStr;
                    task.isCurrentlyTracked = isTracked;
                    
                    // Sync internal timer state with ClickUp API state
                    // If ClickUp says it's tracked but we don't have an internal timer, start one
                    // This handles the case where timer was started externally (e.g., in ClickUp web)
                    if (isTracked && !this.internalTimerStartTimes.has(task.id)) {
                        this.internalTimerStartTimes.set(task.id, Date.now());
                        this.log(`Synced internal timer for task ${task.id} (started externally)`);
                    }
                });
            } else {
                // No task is currently tracked according to ClickUp API
                // Clear all internal timers (ClickUp has updated time_spent for all when tracking stopped)
                if (this.internalTimerStartTimes.size > 0) {
                    this.internalTimerStartTimes.clear();
                    this.log(`Cleared all internal timers (no task currently tracked, time_spent updated)`);
                }
            }
            
            // time_spent is already included in the task object from getTasksFromList
            // It's in milliseconds according to ClickUp API documentation
            return filteredTasks;
        } catch (error: any) {
            if (error.response) {
                if (error.response.status === 401) {
                    throw new Error('Invalid ClickUp API token. Please check your configuration.');
                }
                throw new Error(`ClickUp API error: ${error.response.data?.err || error.message}`);
            }
            throw error;
        }
    }

    private async getTasksFromList(
        client: AxiosInstance, 
        listId: string, 
        space: any, 
        assigneeId?: string
    ): Promise<ClickUpTask[]> {
        try {
            const params: any = {
                include_closed: true,  // Include closed tasks to get all tasks
                subtasks: true,  // Include subtasks (at least 1 level deep)
                include_timl: true  // Include tasks that exist in multiple lists (Tasks in Multiple Lists)
            };

            // Use API filtering by assignee if provided - this is more efficient and accurate
            // The debug method confirmed this works correctly
            if (assigneeId) {
                params.assignees = [assigneeId];
            }

            // Fetch all pages of tasks
            const allTasks: any[] = [];
            let page = 0;
            let hasMore = true;
            const pageSize = 100; // ClickUp API default page size

            while (hasMore) {
                params.page = page;
                const response = await client.get(`/list/${listId}/task`, { 
                    params,
                    // Ensure array parameters are properly formatted
                    paramsSerializer: (params) => {
                        const searchParams = new URLSearchParams();
                        Object.keys(params).forEach(key => {
                            const value = params[key];
                            if (Array.isArray(value)) {
                                value.forEach(v => searchParams.append(`${key}[]`, String(v)));
                            } else {
                                searchParams.append(key, String(value));
                            }
                        });
                        return searchParams.toString();
                    }
                });
                
                const tasks = response.data.tasks || [];
                allTasks.push(...tasks);
                
                // Check if there are more pages
                // Stop if we got fewer tasks than page size (last page)
                hasMore = tasks.length === pageSize;
                page++;
                
                // Safety limit to prevent infinite loops
                if (page > 100) {
                    this.log(`WARNING: Reached pagination limit for list ${listId}`);
                    break;
                }
            }

            // Process tasks and extract subtasks
            const processedTasks: ClickUpTask[] = [];
            const processedTaskIds = new Set<string>(); // Track processed task IDs to avoid duplicates

            for (const task of allTasks) {
                // Process main task
                if (!processedTaskIds.has(task.id)) {
                    processedTaskIds.add(task.id);
                    
                    // Extract time_spent from task object (in milliseconds according to ClickUp API)
                    // Handle both number and string formats
                    let timeTracked = 0;
                    if (task.time_spent !== undefined && task.time_spent !== null) {
                        timeTracked = typeof task.time_spent === 'string' 
                            ? parseInt(task.time_spent, 10) || 0
                            : Number(task.time_spent) || 0;
                    }
                    
                    processedTasks.push({
                        ...task,
                        space: {
                            id: space.id,
                            name: space.name
                        },
                        timeTracked
                    });
                }

                // Extract and process subtasks (at least 1 level deep)
                // ClickUp API may return subtasks nested in task.subtasks array
                if (task.subtasks && Array.isArray(task.subtasks)) {
                    for (const subtask of task.subtasks) {
                        if (!processedTaskIds.has(subtask.id)) {
                            processedTaskIds.add(subtask.id);
                            
                            // Extract time_spent from subtask
                            let subtaskTimeTracked = 0;
                            if (subtask.time_spent !== undefined && subtask.time_spent !== null) {
                                subtaskTimeTracked = typeof subtask.time_spent === 'string' 
                                    ? parseInt(subtask.time_spent, 10) || 0
                                    : Number(subtask.time_spent) || 0;
                            }
                            
                            processedTasks.push({
                                ...subtask,
                                space: {
                                    id: space.id,
                                    name: space.name
                                },
                                timeTracked: subtaskTimeTracked
                            });
                        }
                    }
                }
            }

            return processedTasks;
        } catch (error) {
            this.log(`Error fetching tasks from list ${listId}: ${error}`);
            return [];
        }
    }

    /**
     * Get the elapsed time (in milliseconds) for a task if it's currently being tracked internally
     * @param taskId The task ID to check
     * @returns Elapsed time in milliseconds, or 0 if not tracked
     */
    getInternalTimerElapsed(taskId: string): number {
        const startTime = this.internalTimerStartTimes.get(taskId);
        if (!startTime) {
            return 0;
        }
        return Date.now() - startTime;
    }

    /**
     * Check if a task is being tracked internally
     * @param taskId The task ID to check
     * @returns True if the task has an internal timer running
     */
    isInternallyTracked(taskId: string): boolean {
        return this.internalTimerStartTimes.has(taskId);
    }

    /**
     * Clear internal timer for a specific task (used when stopping tracking)
     * @param taskId The task ID to clear
     */
    clearInternalTimer(taskId: string): void {
        this.internalTimerStartTimes.delete(taskId);
    }

}

