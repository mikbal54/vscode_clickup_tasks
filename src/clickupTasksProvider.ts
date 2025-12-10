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

export class ClickUpTasksProvider implements vscode.TreeDataProvider<ClickUpTaskItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ClickUpTaskItem | undefined | null | void> = new vscode.EventEmitter<ClickUpTaskItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ClickUpTaskItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private tasks: ClickUpTask[] = [];
    private loading: boolean = false;
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
        this._onDidChangeTreeData.fire();
        
        this.clickUpService.getInProgressTasks()
            .then(tasks => {
                this.tasks = tasks;
                this.loading = false;
                this._onDidChangeTreeData.fire();
            })
            .catch(error => {
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

    getTreeItem(element: ClickUpTaskItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ClickUpTaskItem): Thenable<ClickUpTaskItem[]> {
        if (this.loading) {
            const loadingItem = new ClickUpTaskItem(null, 'Loading...', vscode.TreeItemCollapsibleState.None);
            return Promise.resolve([loadingItem]);
        }

        if (!element) {
            // Root level - return all tasks
            if (this.tasks.length === 0) {
                const emptyItem = new ClickUpTaskItem(null, 'No "In Progress" tasks assigned to you', vscode.TreeItemCollapsibleState.None);
                return Promise.resolve([emptyItem]);
            }

            return Promise.resolve(
                this.tasks.map(task => {
                    // Format: "Task Name [internal_timer+time_spent/time_estimate]"
                    // Example: "[2m30s+5m/2h]"
                    let timeDisplay = '';
                    
                    // Get internal timer elapsed time if task is currently tracked
                    const internalElapsed = task.isCurrentlyTracked 
                        ? this.clickUpService.getInternalTimerElapsed(task.id) 
                        : 0;
                    const hasInternalTimer = internalElapsed > 0;
                    
                    const hasTracked = task.timeTracked && task.timeTracked > 0;
                    const hasEstimate = task.time_estimate && task.time_estimate > 0;
                    
                    // Build the time display string
                    if (hasInternalTimer || hasTracked || hasEstimate) {
                        const parts: string[] = [];
                        
                        // Internal timer (with seconds for precision)
                        if (hasInternalTimer) {
                            parts.push(formatTime(internalElapsed, true));
                        }
                        
                        // Time spent from API
                        if (hasTracked) {
                            const trackedFormatted = formatTime(task.timeTracked!);
                            if (hasInternalTimer) {
                                parts.push(`+${trackedFormatted}`);
                            } else {
                                parts.push(trackedFormatted);
                            }
                        } else if (hasInternalTimer) {
                            // If we have internal timer but no tracked time, show +0m
                            parts.push('+0m');
                        }
                        
                        // Time estimate
                        if (hasEstimate) {
                            const estimateFormatted = formatTime(task.time_estimate!);
                            parts.push(`/${estimateFormatted}`);
                        }
                        
                        timeDisplay = `[${parts.join('')}]`;
                    }
                    
                    const label = timeDisplay 
                        ? `${task.name} ${timeDisplay}`
                        : task.name;
                    return new ClickUpTaskItem(task, label, vscode.TreeItemCollapsibleState.None);
                })
            );
        }

        return Promise.resolve([]);
    }
}

