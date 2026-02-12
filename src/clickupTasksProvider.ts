import * as vscode from 'vscode';
import { ClickUpService, ClickUpTask } from './clickupService';

/**
 * Format time in milliseconds to a human-readable string like "3h23m" or "2m30s"
 * @param milliseconds Time in milliseconds
 * @param includeSeconds Whether to include seconds for short durations (default: false)
 * @returns Formatted string like "3h23m" or "2m30s" or empty string if no time
 */
function formatTime(milliseconds: number, includeSeconds: boolean = false): string {
    if (!milliseconds || milliseconds <= 0) {
        return '';
    }
    
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    if (includeSeconds && hours === 0 && minutes < 1) {
        // For very short durations, show seconds
        return `${seconds}s`;
    } else if (includeSeconds && hours === 0 && minutes > 0) {
        // For short durations with minutes, show minutes and seconds
        return `${minutes}m${seconds}s`;
    } else if (hours > 0 && minutes > 0) {
        return `${hours}h${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h`;
    } else if (minutes > 0) {
        return `${minutes}m`;
    } else if (includeSeconds && seconds > 0) {
        return `${seconds}s`;
    } else {
        return '';
    }
}

/** Tree item representing a List group (collapsible header). */
export class ClickUpListGroupItem extends vscode.TreeItem {
    constructor(
        public readonly listId: string,
        public readonly listName: string,
        taskCount: number
    ) {
        super(listName, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'clickupListGroup';
        this.description = `${taskCount} task${taskCount !== 1 ? 's' : ''}`;
        this.iconPath = new vscode.ThemeIcon('list-unordered');
    }
}

export class ClickUpTaskItem extends vscode.TreeItem {
    constructor(
        public readonly task: ClickUpTask | null,
        label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        
            if (task) {
            const timeFormatted = task.timeTracked ? formatTime(task.timeTracked) : '';
            const statusText = task.status?.status || 'Unknown';
            const trackingIndicator = task.isCurrentlyTracked ? ' (Recording)' : '';
            
            this.tooltip = `${task.name}\nStatus: ${statusText}${timeFormatted ? `\nTime Tracked: ${timeFormatted}` : ''}${task.isCurrentlyTracked ? '\nCurrently recording time' : ''}\n${task.url}\n\nClick: Copy task ID\nRight-click: ${task.isCurrentlyTracked ? 'Stop' : 'Start'} time tracking`;
            this.description = statusText + trackingIndicator;
            
            // Use different context value and icon for currently tracked task
            if (task.isCurrentlyTracked) {
                this.contextValue = 'clickupTaskTracked';
                // Show red circle icon when currently tracked
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('errorForeground'));
            } else {
                this.contextValue = 'clickupTask';
                // No icon when not tracked
            }
            
            // Set command for normal click to copy task ID
            this.command = {
                command: 'clickupTasks.copyTaskIdFromItem',
                title: 'Copy Task ID',
                arguments: [this]
            };
        }
    }
}

export class ClickUpTasksProvider implements vscode.TreeDataProvider<ClickUpTaskItem | ClickUpListGroupItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ClickUpTaskItem | ClickUpListGroupItem | undefined | null | void> = new vscode.EventEmitter<ClickUpTaskItem | ClickUpListGroupItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ClickUpTaskItem | ClickUpListGroupItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private tasks: ClickUpTask[] = [];
    private loading: boolean = false;
    private refreshSequence: number = 0;
    private updateInterval: NodeJS.Timeout | undefined;

    constructor(private clickUpService: ClickUpService) {
        // Update display every second to show live timer updates
        this.updateInterval = setInterval(() => {
            // Only update if we have tasks and at least one is being tracked
            if (this.tasks.length > 0 && this.tasks.some(task => task.isCurrentlyTracked)) {
                this._onDidChangeTreeData.fire();
            }
        }, 1000);
    }

    dispose() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
    }

    refresh(): void {
        this.loading = true;
        const thisRefresh = ++this.refreshSequence;
        this._onDidChangeTreeData.fire();

        this.clickUpService.getInProgressTasks()
            .then(tasks => {
                // Only apply if this is still the latest refresh (ignore stale responses)
                if (thisRefresh !== this.refreshSequence) {
                    return;
                }
                this.tasks = tasks;
                this.loading = false;
                this._onDidChangeTreeData.fire();
            })
            .catch(error => {
                if (thisRefresh !== this.refreshSequence) {
                    return;
                }
                console.error('ClickUpTasksProvider: Error loading tasks', error);
                this.loading = false;
                this._onDidChangeTreeData.fire();
                // Use status bar message for auto-dismiss since we can't import the helper here easily
                vscode.window.setStatusBarMessage(`Failed to load ClickUp tasks: ${error.message}`, 5000);
                vscode.window.showErrorMessage(`Failed to load ClickUp tasks: ${error.message}`);
            });
    }

    /**
     * Update a single task in the list without refreshing all tasks
     * @param taskId The task ID to update
     */
    async updateTask(taskId: string): Promise<void> {
        try {
            // Fetch the updated task from ClickUp
            const updatedTask = await this.clickUpService.getTask(taskId);
            if (!updatedTask) {
                // Task not found, might have been deleted or moved
                // Remove it from our list
                this.tasks = this.tasks.filter(t => t.id !== taskId);
                this._onDidChangeTreeData.fire();
                return;
            }

            // Find and update the task in our list
            const taskIndex = this.tasks.findIndex(t => t.id === taskId);
            if (taskIndex >= 0) {
                // Preserve list and space info from existing task (Get Task API might not return it)
                const existingTask = this.tasks[taskIndex];
                updatedTask.list = existingTask.list;
                if (existingTask.space && !updatedTask.space) {
                    updatedTask.space = existingTask.space;
                }
                
                // Check if the task is currently being tracked (for internal timer display)
                // This handles both starting (true) and stopping (false) scenarios
                updatedTask.isCurrentlyTracked = this.clickUpService.isInternallyTracked(taskId);
                this.tasks[taskIndex] = updatedTask;
                this._onDidChangeTreeData.fire();
            } else {
                // Task not in our list - might have changed status or assignment
                // Don't add it here, let full refresh handle it
            }
        } catch (error: any) {
            console.error('ClickUpTasksProvider: Error updating task', error);
            // On error, fall back to full refresh
            this.refresh();
        }
    }

    getTreeItem(element: ClickUpTaskItem | ClickUpListGroupItem): vscode.TreeItem {
        return element;
    }

    private buildTaskItem(task: ClickUpTask): ClickUpTaskItem {
        let timeDisplay = '';
        const internalElapsed = task.isCurrentlyTracked
            ? this.clickUpService.getInternalTimerElapsed(task.id)
            : 0;
        const hasInternalTimer = internalElapsed > 0;
        const hasTracked = task.timeTracked && task.timeTracked > 0;
        const hasEstimate = task.time_estimate && task.time_estimate > 0;

        if (hasInternalTimer || hasTracked || hasEstimate) {
            const parts: string[] = [];
            if (hasInternalTimer) {
                parts.push(formatTime(internalElapsed, true));
            }
            if (hasTracked) {
                const trackedFormatted = formatTime(task.timeTracked!);
                parts.push(hasInternalTimer ? `+${trackedFormatted}` : trackedFormatted);
            } else if (hasInternalTimer) {
                parts.push('+0m');
            }
            if (hasEstimate) {
                parts.push(`/${formatTime(task.time_estimate!)}`);
            }
            timeDisplay = `[${parts.join('')}]`;
        }
        const label = timeDisplay ? `${task.name} ${timeDisplay}` : task.name;
        return new ClickUpTaskItem(task, label, vscode.TreeItemCollapsibleState.None);
    }

    getChildren(element?: ClickUpTaskItem | ClickUpListGroupItem): Thenable<(ClickUpTaskItem | ClickUpListGroupItem)[]> {
        if (this.loading) {
            const loadingItem = new ClickUpTaskItem(null, 'Loading...', vscode.TreeItemCollapsibleState.None);
            return Promise.resolve([loadingItem]);
        }

        const groupByList = vscode.workspace.getConfiguration('clickupTasks').get<boolean>('groupByList', true);

        if (!element) {
            // Root level
            if (this.tasks.length === 0) {
                const emptyItem = new ClickUpTaskItem(null, 'No "In Progress" tasks assigned to you', vscode.TreeItemCollapsibleState.None);
                return Promise.resolve([emptyItem]);
            }

            if (groupByList) {
                // Group tasks by list (list id -> tasks)
                const byList = new Map<string, ClickUpTask[]>();
                for (const task of this.tasks) {
                    const listId = task.list?.id ?? '';
                    const listName = task.list?.name ?? 'No list';
                    if (!byList.has(listId)) {
                        byList.set(listId, []);
                    }
                    byList.get(listId)!.push(task);
                }
                const listNames = new Map<string, string>();
                for (const task of this.tasks) {
                    const id = task.list?.id ?? '';
                    if (!listNames.has(id)) listNames.set(id, task.list?.name ?? 'No list');
                }
                const entries = Array.from(byList.entries()).sort((a, b) => {
                    const nameA = listNames.get(a[0]) ?? 'No list';
                    const nameB = listNames.get(b[0]) ?? 'No list';
                    if (nameA === 'No list') return 1;
                    if (nameB === 'No list') return -1;
                    return nameA.localeCompare(nameB);
                });
                const groupItems: ClickUpListGroupItem[] = entries.map(([listId, tasks]) => {
                    const listName = listNames.get(listId) ?? 'No list';
                    return new ClickUpListGroupItem(listId, listName, tasks.length);
                });
                return Promise.resolve(groupItems);
            }

            return Promise.resolve(this.tasks.map(task => this.buildTaskItem(task)));
        }

        if (element instanceof ClickUpListGroupItem) {
            const listId = element.listId;
            const listTasks = this.tasks.filter(t => (t.list?.id ?? '') === listId);
            return Promise.resolve(listTasks.map(task => this.buildTaskItem(task)));
        }

        return Promise.resolve([]);
    }
}

