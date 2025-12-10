import * as vscode from 'vscode';
import { ClickUpTasksProvider, ClickUpTaskItem } from './clickupTasksProvider';
import { ClickUpService, ClickUpTask } from './clickupService';

let clickUpService: ClickUpService;
let tasksProvider: ClickUpTasksProvider;
let outputChannel: vscode.OutputChannel;
let refreshCountdownStatusBarItem: vscode.StatusBarItem | undefined;
let refreshCountdownInterval: NodeJS.Timeout | undefined;
let nextRefreshTime: number = 0;

/**
 * Helper function to show a notification that auto-dismisses after 5 seconds
 * Since VS Code doesn't provide a way to programmatically dismiss toast notifications,
 * we use a workaround: show the notification and track it with a timeout.
 * After 5 seconds, we show a very brief status bar message to provide visual feedback.
 * Note: The toast notification may still be visible but won't block interaction.
 * @param message The message to display
 * @param type The type of notification
 * @returns A promise that resolves when the notification is dismissed
 */
function showAutoDismissNotification(
    message: string,
    type: 'information' | 'warning' | 'error' = 'information'
): Thenable<string | undefined> {
    // Show the toast notification for immediate visibility
    let notificationPromise: Thenable<string | undefined>;
    switch (type) {
        case 'information':
            notificationPromise = vscode.window.showInformationMessage(message);
            break;
        case 'warning':
            notificationPromise = vscode.window.showWarningMessage(message);
            break;
        case 'error':
            notificationPromise = vscode.window.showErrorMessage(message);
            break;
    }
    
    // Set a timeout to track when 5 seconds have passed
    // After 5 seconds, show a brief status bar message as visual feedback
    const timeout = setTimeout(() => {
        // Show a brief status bar message to indicate the notification has "expired"
        // The toast notification may still be visible but is no longer blocking
        vscode.window.setStatusBarMessage('', 100);
    }, 5000);
    
    // Clean up timeout if notification is dismissed early by user
    notificationPromise.then(() => {
        clearTimeout(timeout);
    }, () => {
        clearTimeout(timeout);
    });
    
    return notificationPromise;
}

export function activate(context: vscode.ExtensionContext) {
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('ClickUp Tasks');
    outputChannel.appendLine('ClickUp Tasks extension is now active!');
    outputChannel.show(true); // Show output channel automatically for debugging
    
    console.log('ClickUp Tasks extension is now active!');

    // Initialize ClickUp service with output channel for logging
    clickUpService = new ClickUpService(outputChannel);

    // Create and register the tree data provider
    tasksProvider = new ClickUpTasksProvider(clickUpService);
    
    // Register the view in the Source Control container
    const view = vscode.window.createTreeView('clickupTasks', {
        treeDataProvider: tasksProvider,
        showCollapseAll: true
    });

    // Note: We removed onDidChangeSelection handler
    // Normal click is now handled via the command property on TreeItem
    // Ctrl+Click is handled automatically by VS Code via resourceUri

    // Function to format countdown time
    function formatCountdown(seconds: number): string {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    // Register countdown command (clicking it refreshes)
    const countdownCommand = vscode.commands.registerCommand('clickupTasks.countdown', () => {
        tasksProvider.refresh();
        const config = vscode.workspace.getConfiguration('clickupTasks');
        if (config.get<boolean>('autoRefresh', true)) {
            startCountdown(5 * 60 * 1000);
        }
    });
    context.subscriptions.push(countdownCommand);

    // Function to update countdown display
    function updateCountdown() {
        const now = Date.now();
        const timeRemaining = Math.max(0, Math.floor((nextRefreshTime - now) / 1000));
        const countdownText = timeRemaining > 0 ? formatCountdown(timeRemaining) : '5:00';
        
        // Update view title to show countdown in the panel header
        // This appears near the refresh button in the view title area
        view.title = `ClickUp Tasks (${countdownText})`;
    }

    // Function to start countdown timer
    function startCountdown(intervalMs: number) {
        nextRefreshTime = Date.now() + intervalMs;
        
        // Clear existing interval if any
        if (refreshCountdownInterval) {
            clearInterval(refreshCountdownInterval);
        }
        
        // Update immediately
        updateCountdown();
        
        // Update every second
        refreshCountdownInterval = setInterval(() => {
            updateCountdown();
        }, 1000);
        
        context.subscriptions.push({
            dispose: () => {
                if (refreshCountdownInterval) {
                    clearInterval(refreshCountdownInterval);
                }
            }
        });
    }

    // Register commands
    const refreshCommand = vscode.commands.registerCommand('clickupTasks.refresh', () => {
        tasksProvider.refresh();
        // Reset countdown after manual refresh
        const config = vscode.workspace.getConfiguration('clickupTasks');
        if (config.get<boolean>('autoRefresh', true)) {
            startCountdown(5 * 60 * 1000); // 5 minutes
        }
    });

    const configureCommand = vscode.commands.registerCommand('clickupTasks.configure', async () => {
        const apiToken = await vscode.window.showInputBox({
            prompt: 'Enter your ClickUp API token',
            placeHolder: 'pk_xxxxx...',
            value: vscode.workspace.getConfiguration('clickupTasks').get<string>('apiToken', ''),
            password: true
        });

        if (apiToken) {
        await vscode.workspace.getConfiguration('clickupTasks').update('apiToken', apiToken, vscode.ConfigurationTarget.Global);
        showAutoDismissNotification('ClickUp API token saved!', 'information');
        tasksProvider.refresh();
        }
    });

    const openSettingsCommand = vscode.commands.registerCommand('clickupTasks.openSettings', async () => {
        // Open settings UI and filter to show all ClickUp Tasks extension settings
        await vscode.commands.executeCommand('workbench.action.openSettings', 'clickupTasks');
    });

    const resetSettingsCommand = vscode.commands.registerCommand('clickupTasks.resetSettings', async () => {
        const config = vscode.workspace.getConfiguration('clickupTasks');
        const result = await vscode.window.showWarningMessage(
            'Are you sure you want to reset all ClickUp Tasks settings? This will clear your API token and all other settings.',
            { modal: true },
            'Reset',
            'Cancel'
        );

        if (result === 'Reset') {
            // Reset all ClickUp Tasks settings to their defaults
            await config.update('apiToken', undefined, vscode.ConfigurationTarget.Global);
            await config.update('teamId', undefined, vscode.ConfigurationTarget.Global);
            await config.update('autoRefresh', undefined, vscode.ConfigurationTarget.Global);
            await config.update('inProgressStatuses', undefined, vscode.ConfigurationTarget.Global);
            
            showAutoDismissNotification('All ClickUp Tasks settings have been reset to defaults.', 'information');
            tasksProvider.refresh();
        }
    });

    const showLogsCommand = vscode.commands.registerCommand('clickupTasks.showLogs', () => {
        outputChannel.show(true);
    });

    const debugCommand = vscode.commands.registerCommand('clickupTasks.debug', async () => {
        try {
            await clickUpService.debugFetchRawTasks();
            showAutoDismissNotification('Debug info written to output channel', 'information');
        } catch (error: any) {
            showAutoDismissNotification(`Debug failed: ${error.message}`, 'error');
        }
    });

    const debugListMyTasksCommand = vscode.commands.registerCommand('clickupTasks.debugListMyTasks', async () => {
        try {
            await clickUpService.debugListAllMyTasks();
            showAutoDismissNotification('Task list written to output channel', 'information');
        } catch (error: any) {
            showAutoDismissNotification(`Debug failed: ${error.message}`, 'error');
        }
    });

    const openTaskCommand = vscode.commands.registerCommand('clickupTasks.openTask', (item: ClickUpTaskItem) => {
        if (item.task) {
            vscode.env.openExternal(vscode.Uri.parse(item.task.url));
        }
    });

    const copyTaskIdCommand = vscode.commands.registerCommand('clickupTasks.copyTaskId', async (taskId: string) => {
        const taskIdFormatted = `CU-${taskId}`;
        await vscode.env.clipboard.writeText(taskIdFormatted);
        showAutoDismissNotification(`Copied ${taskIdFormatted} to clipboard`, 'information');
    });

    const copyTaskIdFromItemCommand = vscode.commands.registerCommand('clickupTasks.copyTaskIdFromItem', async (item: ClickUpTaskItem) => {
        if (item.task) {
            const taskIdFormatted = `CU-${item.task.id}`;
            await vscode.env.clipboard.writeText(taskIdFormatted);
            showAutoDismissNotification(`Copied ${taskIdFormatted} to clipboard`, 'information');
        }
    });

    const playTaskCommand = vscode.commands.registerCommand('clickupTasks.playTask', async (taskOrItem?: ClickUpTask | ClickUpTaskItem) => {
        // Handle both ClickUpTask and ClickUpTaskItem, or undefined
        if (!taskOrItem) {
            showAutoDismissNotification('No task selected. Please select a task to start time tracking.', 'error');
            return;
        }
        
        const task = 'task' in taskOrItem ? taskOrItem.task : taskOrItem;
        if (!task) {
            showAutoDismissNotification('Invalid task. Please select a valid task to start time tracking.', 'error');
            return;
        }
        
        try {
            const taskName = task.name || 'Unknown Task';
            const taskId = task.id || '';
            
            if (!taskId) {
                showAutoDismissNotification('Task ID is missing. Cannot start time tracking.', 'error');
                return;
            }
            
            outputChannel.appendLine(`Starting time tracking for task: ${taskName} (${taskId})`);
            await clickUpService.startTimeTracking(taskId);
            
            showAutoDismissNotification(`Started time tracking for: ${taskName}`, 'information');
            
            // Update only the started task instead of refreshing the whole list
            await tasksProvider.updateTask(taskId);
        } catch (error: any) {
            const errorMessage = error.message || 'Unknown error';
            outputChannel.appendLine(`Error starting time tracking: ${errorMessage}`);
            showAutoDismissNotification(`Failed to start time tracking: ${errorMessage}`, 'error');
        }
    });

    const stopTaskCommand = vscode.commands.registerCommand('clickupTasks.stopTask', async (taskOrItem?: ClickUpTask | ClickUpTaskItem) => {
        try {
            let taskId: string | undefined;
            
            // Handle both ClickUpTask and ClickUpTaskItem, or undefined
            if (taskOrItem) {
                const task = 'task' in taskOrItem ? taskOrItem.task : taskOrItem;
                if (task) {
                    taskId = task.id;
                    const taskName = task.name || 'Unknown Task';
                    outputChannel.appendLine(`Stopping time tracking for task: ${taskName}`);
                }
            }
            
            if (!taskId) {
                outputChannel.appendLine(`Stopping time tracking (no task specified)`);
            }
            
            const stoppedTaskId = await clickUpService.stopTimeTracking();
            
            // Clear internal timer for this task (if not already cleared by stopTimeTracking)
            if (taskId) {
                clickUpService.clearInternalTimer(taskId);
            }
            
            showAutoDismissNotification(`Stopped time tracking`, 'information');
            
            // Update only the stopped task instead of refreshing the whole list
            const taskToUpdate = stoppedTaskId || taskId;
            if (taskToUpdate) {
                await tasksProvider.updateTask(taskToUpdate);
            } else {
                // Fallback to full refresh if we can't determine which task to update
                tasksProvider.refresh();
            }
        } catch (error: any) {
            const errorMessage = error.message || 'Unknown error';
            outputChannel.appendLine(`Error stopping time tracking: ${errorMessage}`);
            showAutoDismissNotification(`Failed to stop time tracking: ${errorMessage}`, 'error');
        }
    });

    // Auto-refresh if enabled
    const config = vscode.workspace.getConfiguration('clickupTasks');
    const refreshInterval = 5 * 60 * 1000; // 5 minutes
    
    if (config.get<boolean>('autoRefresh', true)) {
        // Start countdown timer
        startCountdown(refreshInterval);
        
        const interval = setInterval(() => {
            tasksProvider.refresh();
            // Reset countdown after auto refresh
            startCountdown(refreshInterval);
        }, refreshInterval);

        context.subscriptions.push({
            dispose: () => {
                clearInterval(interval);
                if (refreshCountdownInterval) {
                    clearInterval(refreshCountdownInterval);
                }
            }
        });
    }

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('clickupTasks')) {
                tasksProvider.refresh();
            }
        })
    );

    context.subscriptions.push(
        view, 
        refreshCommand, 
        configureCommand, 
        openSettingsCommand, 
        resetSettingsCommand, 
        showLogsCommand, 
        debugCommand, 
        debugListMyTasksCommand, 
        openTaskCommand, 
        copyTaskIdCommand, 
        copyTaskIdFromItemCommand, 
        playTaskCommand, 
        stopTaskCommand,
        { dispose: () => tasksProvider.dispose() } // Clean up provider interval
    );

    // Initial load
    tasksProvider.refresh();
}

export function deactivate() {}


