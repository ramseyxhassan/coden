import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Track the last known document content to detect changes
const documentContentCache = new Map<string, string>();
// Track if a document was just opened to avoid tracking initial content as changes
const recentlyOpenedDocuments = new Set<string>();
// Log file name
const LOG_FILE_NAME = 'coden.json';
// Store language statistics to help identify models
const languageStats = new Map<string, number>();

// Adding version info for tracking
const EXTENSION_VERSION = '0.1.0';

// Create status bar item as a module-level variable
let statusBarItem: vscode.StatusBarItem;

// Context size limits (in characters)
const MAX_CONTEXT_SIZE = 200;

// Create decorations for AI-generated code
const aiHoverDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(65, 105, 225, 0.05)',
    border: '1px dashed rgba(65, 105, 225, 0.3)',
    borderRadius: '3px',
});

// Track AI-generated regions that have been logged
const aiGeneratedRegions = new Map<string, Array<{
    id: string,
    startLine: number,
    endLine: number,
    startChar: number,
    endChar: number,
    text: string,
    timestamp: number
}>>();

// Track document statistics
const documentStats = new Map<string, {
    totalChars: number,
    totalLines: number,
    aiChars: number,
    aiLines: number
}>();

// Track deleted AI code
const deletedAICode = new Map<string, Array<{
    id: string,
    text: string,
    deletedAt: number,
    originalTimestamp: number
}>>();

export function activate(context: vscode.ExtensionContext) {
    console.log('Coden: Coden Tracker extension is now active');

    // Initialize status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(coden) Coden";
    statusBarItem.tooltip = "Tracking Coden suggestions";
    statusBarItem.command = "coden.showStats";
    context.subscriptions.push(statusBarItem);

    // Enable tracking by default on first run
    if (context.globalState.get('trackingEnabled') === undefined) {
        context.globalState.update('trackingEnabled', true);
    }

    // Show the status of tracking in the status bar
    updateStatusBar(context.globalState.get('trackingEnabled') as boolean);

    // Track recently opened documents to avoid tracking initial content
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            const docUri = doc.uri.toString();
            recentlyOpenedDocuments.add(docUri);
            
            // Remove from tracking after a second
            setTimeout(() => {
                recentlyOpenedDocuments.delete(docUri);
            }, 1000);
        })
    );

    // Register toggle command
    let toggleCommand = vscode.commands.registerCommand('coden.toggleTracking', () => {
        const currentState = context.globalState.get('trackingEnabled') as boolean;
        const newState = !currentState;
        context.globalState.update('trackingEnabled', newState);
        updateStatusBar(newState);
        
        vscode.window.showInformationMessage(`Coden suggestion tracking ${newState ? 'Enabled' : 'Disabled'}`);
    });

    // Register command to show suggestion statistics
    let showStatsCommand = vscode.commands.registerCommand('coden.showStats', () => {
        showSuggestionStats(context);
    });

    // Add handler for editor switching to update decorations
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                updateDecorations(editor);
            }
        })
    );
    
    // Add handler for document changes to update decorations
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            vscode.window.visibleTextEditors.forEach(editor => {
                if (editor.document.uri.toString() === event.document.uri.toString()) {
                    updateDecorations(editor);
                }
            });
        })
    );
    
    // Immediately update decorations for the active editor
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
    }

    // Track document changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (!context.globalState.get('trackingEnabled')) {
                return;
            }

            const doc = event.document;
            const docUri = doc.uri.toString();
            
            if (recentlyOpenedDocuments.has(docUri)) {
                return;
            }

            const fileName = path.basename(doc.fileName);
            if (fileName === LOG_FILE_NAME) {
                return;
            }

            if (docUri.includes('GitHub.copilot') || docUri.includes('output:') || docUri.includes('extension-output')) {
                return;
            }

            const oldContent = documentContentCache.get(docUri) || '';
            const newContent = doc.getText();
            
            // First check if AI code was deleted
            checkForDeletedAICode(doc, event.contentChanges);
            
            // Then check for new AI suggestions
            for (const change of event.contentChanges) {
                if (isProbablyTrackPilotSuggestion(change.text, doc.languageId)) {
                    incrementLanguageCount(doc.languageId);
                    
                    logSuggestion(doc, change, oldContent, newContent);
                }
            }
            
            // Update document statistics regardless of whether AI code was added
            updateDocumentStats(doc);
            
            // Update cache with new content
            documentContentCache.set(docUri, newContent);
        })
    );

    context.subscriptions.push(toggleCommand, showStatsCommand);

    // Update status bar visibility based on tracking state
    function updateStatusBar(trackingEnabled: boolean) {
        if (trackingEnabled) {
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    }

    // Function to apply decorations to AI-generated code
    function updateDecorations(editor: vscode.TextEditor) {
        const docUri = editor.document.uri.toString();
        const relPath = vscode.workspace.asRelativePath(editor.document.uri);
        
        // No decorations if this file has no AI regions
        if (!aiGeneratedRegions.has(relPath)) {
            editor.setDecorations(aiHoverDecorationType, []);
            return;
        }
        
        const regions = aiGeneratedRegions.get(relPath) || [];
        const decorations: vscode.DecorationOptions[] = [];
        
        for (const region of regions) {
            // Create a precise decoration range
            const startPos = new vscode.Position(region.startLine, region.startChar);
            
            // Calculate the end position precisely - for multi-line regions,
            // we need to count the characters in the last line
            const lines = region.text.split('\n');
            const lastLineLength = lines[lines.length - 1].length;
            
            // If it's a single line, the end character is the start character plus the text length
            // If it's multiple lines, we need to calculate the end character position on the last line
            const endChar = lines.length === 1 
                ? region.startChar + region.text.length 
                : lastLineLength;
                
            const endPos = new vscode.Position(region.endLine, endChar);
            const range = new vscode.Range(startPos, endPos);
            
            // Create the decoration with hover message
            decorations.push({
                range,
                hoverMessage: new vscode.MarkdownString(
                    `**AI-Generated Code**\n\nInserted: ${new Date(region.timestamp).toLocaleString()}\nID: ${region.id}`
                )
            });
        }
        
        editor.setDecorations(aiHoverDecorationType, decorations);
    }

    // Register hover provider to show information about AI-generated code
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('*', {
            provideHover(document, position, token) {
                // Only process if we have workspace folders
                if (!vscode.workspace.workspaceFolders) {
                    return null;
                }
                
                // Get file path and convert to format matching our logs
                const filePath = document.uri.fsPath;
                const relativePath = vscode.workspace.asRelativePath(filePath);
                
                // Check if we have AI data for this position
                const aiInfo = getAISuggestionAtPosition(relativePath, position.line);
                if (aiInfo) {
                    // Format timestamp for display
                    const timestamp = new Date(aiInfo.timestamp);
                    const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
                        dateStyle: 'medium',
                        timeStyle: 'short'
                    });
                    
                    // Create hover content with markdown
                    const hoverContent = new vscode.MarkdownString();
                    hoverContent.isTrusted = true;
                    
                    hoverContent.appendMarkdown(`## AI-Generated Code\n\n`);
                    hoverContent.appendMarkdown(`**Model:** ${aiInfo.metadata.probableModel}\n\n`);
                    hoverContent.appendMarkdown(`**Generated:** ${dateTimeFormat.format(timestamp)}\n\n`);
                    hoverContent.appendMarkdown(`**Size:** ${aiInfo.metadata.lineCount} lines, ${aiInfo.metadata.charCount} characters\n\n`);
                    
                    if (aiInfo.metadata.estimatedTokens) {
                        hoverContent.appendMarkdown(`**Tokens:** ~${aiInfo.metadata.estimatedTokens}\n\n`);
                    }
                    
                    // Add a command link to show stats
                    hoverContent.appendMarkdown(`[Show All AI Statistics](command:coden.showStats)`);
                    
                    return new vscode.Hover(hoverContent);
                }
                
                return null;
            }
        })
    );
}

// Get all AI-generated ranges for a file
function getAIGeneratedRanges(relativePath: string): vscode.Range[] {
    const ranges: vscode.Range[] = [];
    
    // Only process if we have workspace folders
    if (!vscode.workspace.workspaceFolders) {
        return ranges;
    }
    
    // Get log file path
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const logFilePath = path.join(workspaceRoot, LOG_FILE_NAME);
    
    // Check if log file exists
    if (!fs.existsSync(logFilePath)) {
        return ranges;
    }
    
    try {
        // Read log file
        const logData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
        
        // Find suggestions for this file
        for (const entry of logData) {
            if (entry.file === relativePath) {
                const startLine = entry.range.startLine;
                const startChar = entry.range.startChar;
                const endLine = startLine + (entry.metadata.lineCount - 1);
                const endChar = (endLine === startLine) ? entry.range.endChar : 999; // Use high value for multi-line
                
                ranges.push(new vscode.Range(
                    new vscode.Position(startLine, startChar),
                    new vscode.Position(endLine, endChar)
                ));
            }
        }
    } catch (error) {
        console.error('Error getting AI ranges:', error);
    }
    
    return ranges;
}

// Get AI suggestion at a specific position
function getAISuggestionAtPosition(relativePath: string, line: number): any | null {
    // Only process if we have workspace folders
    if (!vscode.workspace.workspaceFolders) {
        return null;
    }
    
    // Get log file path
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const logFilePath = path.join(workspaceRoot, LOG_FILE_NAME);
    
    // Check if log file exists
    if (!fs.existsSync(logFilePath)) {
        return null;
    }
    
    try {
        // Read log file
        const logData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
        
        // Find suggestions for this file that include the given line
        for (const entry of logData) {
            if (entry.file === relativePath) {
                const startLine = entry.range.startLine;
                const endLine = startLine + (entry.metadata.lineCount - 1);
                
                if (line >= startLine && line <= endLine) {
                    return entry;
                }
            }
        }
    } catch (error) {
        console.error('Error checking AI suggestion:', error);
    }
    
    return null;
}

// Show statistics about Coden suggestions
function showSuggestionStats(context: vscode.ExtensionContext) {
    // Ensure we have a workspace folder
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }
    
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const logFilePath = path.join(workspaceRoot, LOG_FILE_NAME);
    
    // Check if log file exists
    if (!fs.existsSync(logFilePath)) {
        vscode.window.showInformationMessage('No Coden suggestions logged yet');
        return;
    }
    
    try {
        const fileContent = fs.readFileSync(logFilePath, 'utf8');
        const logData = JSON.parse(fileContent);
        
        if (logData.length === 0) {
            vscode.window.showInformationMessage('No Coden suggestions logged yet');
            return;
        }
        
        // Calculate statistics
        const totalSuggestions = logData.length;
        let totalCharacters = 0;
        let totalLines = 0;
        
        // Group by language
        const langStats: Record<string, {count: number, chars: number, lines: number}> = {};
        
        // Group by file
        const fileStats: Record<string, {count: number, chars: number, language: string, lines: number, aiChars: number, aiLines: number, totalChars: number, totalLines: number, aiPercentage: number}> = {};
        
        // Group by model
        const modelStats: Record<string, number> = {};

        // Group by day (for trends)
        const dateStats: Record<string, number> = {};
        
        for (const entry of logData) {
            // Calculate character statistics
            const charCount = entry.metadata?.charCount || 0;
            totalCharacters += charCount;
            
            // Calculate line statistics
            const lineCount = entry.metadata?.lineCount || 0;
            totalLines += lineCount;
            
            // Language statistics
            const lang = entry.language || 'unknown';
            if (!langStats[lang]) {
                langStats[lang] = {count: 0, chars: 0, lines: 0};
            }
            langStats[lang].count += 1;
            langStats[lang].chars += charCount;
            langStats[lang].lines += lineCount;
            
            // File statistics
            const file = entry.file || 'unknown';
            if (!fileStats[file]) {
                fileStats[file] = {count: 0, chars: 0, language: lang, lines: 0, aiChars: 0, aiLines: 0, totalChars: 0, totalLines: 0, aiPercentage: 0};
            }
            fileStats[file].count += 1;
            fileStats[file].chars += charCount;
            fileStats[file].lines += lineCount;
            
            // Model statistics
            const model = entry.metadata?.probableModel || 'unknown';
            modelStats[model] = (modelStats[model] || 0) + 1;
            
            // Date statistics for trend analysis
            if (entry.timestamp) {
                const date = new Date(entry.timestamp).toLocaleDateString();
                dateStats[date] = (dateStats[date] || 0) + 1;
            }
        }
        
        // Get actual stats from the document tracker
        for (const [file, stats] of documentStats.entries()) {
            if (fileStats[file]) {
                fileStats[file].totalChars = stats.totalChars;
                fileStats[file].totalLines = stats.totalLines;
                fileStats[file].aiPercentage = stats.totalChars > 0 ? (stats.aiChars / stats.totalChars) * 100 : 0;
                // Ensure we use the correct AI chars from our document stats
                fileStats[file].aiChars = stats.aiChars;
                fileStats[file].aiLines = stats.aiLines;
            } else {
                fileStats[file] = {
                    count: 0,
                    chars: 0,
                    language: 'unknown',
                    lines: 0,
                    aiChars: stats.aiChars,
                    aiLines: stats.aiLines,
                    totalChars: stats.totalChars,
                    totalLines: stats.totalLines,
                    aiPercentage: stats.totalChars > 0 ? (stats.aiChars / stats.totalChars) * 100 : 0
                };
            }
        }
        
        // Sort languages by count for better organization
        const sortedLangEntries = Object.entries(langStats).sort((a, b) => b[1].count - a[1].count);
        
        // Sort files by count
        const sortedFileEntries = Object.entries(fileStats).sort((a, b) => b[1].count - a[1].count);
        
        const panel = vscode.window.createWebviewPanel(
            'TrackPilotStats',
            'Coden - Copilot Suggestion Stats',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        
        panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Coden - Copilot Suggestion Statistics</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-foreground);
                    max-width: 1000px;
                    margin: 0 auto;
                }
                h1, h2, h3 {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 5px;
                }
                .stat-group {
                    margin-bottom: 30px;
                }
                .stat-item {
                    display: flex;
                    justify-content: space-between;
                    margin: 5px 0;
                    padding: 5px 0;
                    border-bottom: 1px dotted var(--vscode-panel-border);
                }
                .stat-bar {
                    background-color: var(--vscode-button-background);
                    height: 15px;
                    margin-top: 5px;
                    border-radius: 2px;
                }
                .stat-detail {
                    font-size: 0.85em;
                    color: var(--vscode-descriptionForeground);
                }
                .two-columns {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 20px;
                }
                .file-item {
                    margin-bottom: 15px;
                    padding: 10px;
                    background-color: var(--vscode-editor-background);
                    border-radius: 4px;
                    border: 1px solid var(--vscode-panel-border);
                }
                .file-name {
                    font-weight: bold;
                    margin-bottom: 5px;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 10px 0;
                }
                th, td {
                    text-align: left;
                    padding: 8px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                th {
                    background-color: var(--vscode-editor-background);
                }
                .card {
                    padding: 15px;
                    margin-bottom: 15px;
                    background-color: var(--vscode-editor-background);
                    border-radius: 4px;
                    border: 1px solid var(--vscode-panel-border);
                }
                .big-number {
                    font-size: 2em;
                    font-weight: bold;
                    margin: 10px 0;
                }
                .tabs {
                    display: flex;
                    margin-bottom: 20px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .tab {
                    padding: 10px 15px;
                    cursor: pointer;
                    margin-right: 5px;
                    border-radius: 4px 4px 0 0;
                }
                .tab.active {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .tab-content {
                    display: none;
                }
                .tab-content.active {
                    display: block;
                }
                .hidden {
                    display: none;
                }
            </style>
        </head>
        <body>
            <h1>Coden - Copilot Suggestion Statistics</h1>
            
            <div class="tabs">
                <div class="tab active" onclick="switchTab('overview')">Overview</div>
                <div class="tab" onclick="switchTab('languages')">Languages</div>
                <div class="tab" onclick="switchTab('files')">Files</div>
                <div class="tab" onclick="switchTab('models')">AI Models</div>
            </div>

            <div id="overview" class="tab-content active">
                <div class="two-columns">
                    <div class="card">
                        <h3>Total Copilot Suggestions</h3>
                        <div class="big-number">${totalSuggestions}</div>
                        <div class="stat-detail">Since tracking began</div>
                    </div>
                    <div class="card">
                        <h3>Total Characters Added</h3>
                        <div class="big-number">${totalCharacters.toLocaleString()}</div>
                        <div class="stat-detail">Average ${Math.round(totalCharacters / totalSuggestions)} per suggestion</div>
                    </div>
                </div>
                
                <div class="card">
                    <h3>Total Lines of Code</h3>
                    <div class="big-number">${totalLines.toLocaleString()}</div>
                    <div class="stat-detail">Average ${Math.round(totalLines / totalSuggestions)} lines per suggestion</div>
                </div>
                
                <h2>Top Languages</h2>
                <table>
                    <tr>
                        <th>Language</th>
                        <th>Suggestions</th>
                        <th>Characters</th>
                        <th>Lines</th>
                    </tr>
                    ${sortedLangEntries.slice(0, 5).map(([lang, stats]) => `
                        <tr>
                            <td>${lang}</td>
                            <td>${stats.count}</td>
                            <td>${stats.chars.toLocaleString()}</td>
                            <td>${stats.lines}</td>
                        </tr>
                    `).join('')}
                </table>
                
                <h2>Most Active Files</h2>
                <table>
                    <tr>
                        <th>File</th>
                        <th>Language</th>
                        <th>Suggestions</th>
                        <th>Characters</th>
                    </tr>
                    ${sortedFileEntries.slice(0, 5).map(([file, stats]) => `
                        <tr>
                            <td>${file}</td>
                            <td>${stats.language}</td>
                            <td>${stats.count}</td>
                            <td>${stats.chars.toLocaleString()}</td>
                        </tr>
                    `).join('')}
                </table>
            </div>
            
            <div id="languages" class="tab-content">
                <h2>Language Statistics</h2>
                <table>
                    <tr>
                        <th>Language</th>
                        <th>Suggestions</th>
                        <th>% of Total</th>
                        <th>Characters</th>
                        <th>Lines</th>
                        <th>Avg Chars/Suggestion</th>
                    </tr>
                    ${sortedLangEntries.map(([lang, stats]) => {
                        const percentage = Math.round((stats.count / totalSuggestions) * 100);
                        const avgChars = Math.round(stats.chars / stats.count);
                        return `
                        <tr>
                            <td>${lang}</td>
                            <td>${stats.count}</td>
                            <td>${percentage}%</td>
                            <td>${stats.chars.toLocaleString()}</td>
                            <td>${stats.lines}</td>
                            <td>${avgChars}</td>
                        </tr>
                        `;
                    }).join('')}
                </table>
                
                <div class="stat-group">
                    <h3>Language Distribution</h3>
                    ${sortedLangEntries.map(([lang, stats]) => {
                        const percentage = Math.round((stats.count / totalSuggestions) * 100);
                        return `
                        <div class="stat-item">
                            <span>${lang}:</span>
                            <span>${stats.count} (${percentage}%)</span>
                        </div>
                        <div class="stat-bar" style="width: ${percentage}%"></div>
                        `;
                    }).join('')}
                </div>
            </div>
            
            <div id="files" class="tab-content">
                <h2>File Statistics</h2>
                <div class="stat-group">
                    ${sortedFileEntries.map(([file, stats]) => {
                        const percentage = Math.round((stats.count / totalSuggestions) * 100);
                        return `
                        <div class="file-item">
                            <div class="file-name">${file}</div>
                            <div class="stat-item">
                                <span>Language:</span>
                                <span>${stats.language}</span>
                            </div>
                            <div class="stat-item">
                                <span>Suggestions:</span>
                                <span>${stats.count} (${percentage}% of total)</span>
                            </div>
                            <div class="stat-item">
                                <span>Characters:</span>
                                <span>${stats.chars.toLocaleString()}</span>
                            </div>
                            <div class="stat-item">
                                <span>Lines:</span>
                                <span>${stats.lines}</span>
                            </div>
                            <div class="stat-item">
                                <span>AI Characters:</span>
                                <span>${stats.aiChars.toLocaleString()}</span>
                            </div>
                            <div class="stat-item">
                                <span>AI Lines:</span>
                                <span>${stats.aiLines}</span>
                            </div>
                            <div class="stat-item">
                                <span>AI Percentage:</span>
                                <span>${stats.aiPercentage.toFixed(2)}%</span>
                            </div>
                        </div>
                        `;
                    }).join('')}
                </div>
            </div>
            
            <div id="models" class="tab-content">
                <h2>AI Model Statistics</h2>
                <div class="stat-group">
                    ${Object.entries(modelStats).sort((a, b) => b[1] - a[1]).map(([model, count]) => {
                        const percentage = Math.round((count / totalSuggestions) * 100);
                        return `
                        <div class="stat-item">
                            <span>${model}:</span>
                            <span>${count} (${percentage}%)</span>
                        </div>
                        <div class="stat-bar" style="width: ${percentage}%"></div>
                        `;
                    }).join('')}
                </div>
            </div>
            
            <script>
                function switchTab(tabId) {
                    // Hide all tabs
                    document.querySelectorAll('.tab-content').forEach(tab => {
                        tab.classList.remove('active');
                    });
                    
                    // Remove active class from all tab buttons
                    document.querySelectorAll('.tab').forEach(tab => {
                        tab.classList.remove('active');
                    });
                    
                    // Show the selected tab
                    document.getElementById(tabId).classList.add('active');
                    
                    // Add active class to the clicked tab button
                    document.querySelectorAll('.tab').forEach(tab => {
                        if (tab.textContent.toLowerCase().includes(tabId)) {
                            tab.classList.add('active');
                        }
                    });
                }
            </script>
        </body>
        </html>
        `;
        
    } catch (error) {
        vscode.window.showErrorMessage(`Error reading log file: ${error}`);
    }
}

// Track language usage to help infer model
function incrementLanguageCount(languageId: string) {
    const currentCount = languageStats.get(languageId) || 0;
    languageStats.set(languageId, currentCount + 1);
}

// Generate a unique ID for each suggestion
function generateSuggestionId(): string {
    try {
        return crypto.randomUUID();
    } catch (e) {
        // Fallback for older Node.js versions
        return Date.now().toString() + Math.random().toString(36).substring(2);
    }
}

// Try to infer which model might have generated the code
// This is speculative and not 100% accurate
function inferProbableModel(text: string, languageId: string, context?: string): string {
    // Check if we have context that might contain API calls with model information
    if (context) {
        // Look for any Copilot API URLs in the context
        const urlMatch = context.match(/(https?:\/\/[^\s]+(?:githubcopilot|copilot)[^\s]*\/v1\/[^\s]+\/completions)/);
        if (urlMatch && urlMatch[1]) {
            // Just return the entire URL
            return `API URL: ${urlMatch[1]}`;
        }
    }
    
    // Very complex or long multi-line suggestions often come from more capable models
    if (text.length > 500 || text.split('\n').length > 10) {
        return "Likely GPT-4 or GPT-4o";
    }
    
    // Language specific heuristics
    if (languageId === 'python' && (text.includes('def __init__') || text.includes('class '))) {
        return "Likely GPT-3.5 or GPT-4";
    }
    
    if (languageId === 'typescript' && text.includes('interface ')) {
        return "Likely GPT-4";
    }
    
    // Default fallback
    return "GitHub Copilot (model uncertain)";
}

function isProbablyTrackPilotSuggestion(text: string, languageId: string): boolean {
    // Skip single character or very short insertions
    if (text.length <= 3) {
        return false;
    }
    
    // Count lines
    const lineCount = text.split('\n').length;
    
    // Check for code-like structures
    const hasCodeStructures = /[(){}\[\];]/.test(text);
    
    // Check for auto-completion patterns
    const hasAutoCompletePatterns = text.includes('=>') || 
                                   text.includes('function') || 
                                   text.includes('return') ||
                                   text.includes('const ') ||
                                   text.includes('let ') ||
                                   text.includes('var ');
    
    // Check for common programming keywords
    const hasProgrammingKeywords = /\b(if|else|for|while|switch|case|class|import|export)\b/.test(text);
    
    // Language-specific patterns
    let hasLanguageSpecificPatterns = false;
    
    // Python
    if (languageId === 'python') {
        hasLanguageSpecificPatterns = /\b(def|class|import|from|with|as)\b/.test(text);
    }
    // JavaScript/TypeScript
    else if (languageId === 'javascript' || languageId === 'typescript') {
        hasLanguageSpecificPatterns = /\b(async|await|const|let|var|function|class|interface|import|export)\b/.test(text);
    }
    // C#
    else if (languageId === 'csharp') {
        hasLanguageSpecificPatterns = /\b(using|namespace|class|interface|void|public|private|protected|static)\b/.test(text);
    }
    // Java
    else if (languageId === 'java') {
        hasLanguageSpecificPatterns = /\b(public|private|protected|class|interface|enum|import|package|extends|implements)\b/.test(text);
    }
    
    // Multi-line code blocks are very likely from Coden
    if (lineCount > 1 && (hasCodeStructures || hasProgrammingKeywords || hasLanguageSpecificPatterns)) {
        return true;
    }
    
    // Shorter but structured code might also be from Coden
    if ((hasCodeStructures && hasAutoCompletePatterns) || hasLanguageSpecificPatterns) {
        return true;
    }
    
    return false;
}

function logSuggestion(
    doc: vscode.TextDocument,
    change: vscode.TextDocumentContentChangeEvent,
    oldContent: string,
    newContent: string
) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        console.log('No workspace folder found');
        return;
    }
    
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const logFilePath = path.join(workspaceRoot, LOG_FILE_NAME);
    
    const suggestionId = generateSuggestionId();
    
    let contextBefore = '';
    let contextAfter = '';
    try {
        const lines = doc.getText().split('\n');
        const startLine = Math.max(0, change.range.start.line - 3);
        const endLine = Math.min(lines.length - 1, change.range.end.line + 3);
        
        if (startLine < change.range.start.line) {
            contextBefore = lines.slice(startLine, change.range.start.line).join('\n');
            if (contextBefore.length > MAX_CONTEXT_SIZE) {
                contextBefore = contextBefore.substring(contextBefore.length - MAX_CONTEXT_SIZE);
            }
        }
        
        if (endLine > change.range.end.line) {
            contextAfter = lines.slice(change.range.end.line + 1, endLine + 1).join('\n');
            if (contextAfter.length > MAX_CONTEXT_SIZE) {
                contextAfter = contextAfter.substring(0, MAX_CONTEXT_SIZE);
            }
        }
    } catch (e) {
    }
    
    const insertTime = new Date();
    const lineCount = change.text.split('\n').length;
    const estimatedTokens = Math.ceil(change.text.length / 4);
    
    const logEntry = {
        timestamp: insertTime.toISOString(),
        id: suggestionId,
        file: vscode.workspace.asRelativePath(doc.uri),
        language: doc.languageId,
        range: {
            startLine: change.range.start.line,
            startChar: change.range.start.character,
            endLine: change.range.end.line,
            endChar: change.range.end.character
        },
        insertedText: change.text,
        context: {
            before: contextBefore,
            after: contextAfter
        },
        metadata: {
            lineCount: lineCount,
            charCount: change.text.length,
            estimatedTokens: estimatedTokens,
            probableModel: inferProbableModel(change.text, doc.languageId, contextBefore + contextAfter),
            insertedAt: {
                time: insertTime.toTimeString().split(' ')[0],
                date: insertTime.toLocaleDateString(),
                timestamp: insertTime.getTime()
            },
            trackingToolVersion: EXTENSION_VERSION
        }
    };
    
    // Track this AI region for future reference (to detect deletions)
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    if (!aiGeneratedRegions.has(relPath)) {
        aiGeneratedRegions.set(relPath, []);
    }
    
    // Add this region to our tracking
    aiGeneratedRegions.get(relPath)?.push({
        id: suggestionId,
        startLine: change.range.start.line,
        endLine: change.range.start.line + lineCount - 1,
        startChar: change.range.start.character,
        endChar: change.range.end.character,
        text: change.text,
        timestamp: insertTime.getTime()
    });
    
    // Update document statistics
    updateDocumentStats(doc);
    
    // Load existing log or create new
    let logData: any[] = [];
    
    try {
        if (fs.existsSync(logFilePath)) {
            const fileContent = fs.readFileSync(logFilePath, 'utf8');
            logData = JSON.parse(fileContent);
        }
    } catch (error) {
        console.error('Error reading log file:', error);
        vscode.window.showErrorMessage(`Error reading log file: ${logFilePath}`);
    }
    
    // Add new entry
    logData.push(logEntry);
    
    // Write back to file
    try {
        fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2), 'utf8');
        console.log(`Logged Coden suggestion to ${logFilePath}`);
        if (statusBarItem) {
            const originalText = statusBarItem.text;
            statusBarItem.text = "$(coden) Logged";
            setTimeout(() => {
                if (statusBarItem) {
                    statusBarItem.text = originalText;
                }
            }, 2000);
        }
    } catch (error) {
        console.error('Error writing to log file:', error);
        vscode.window.showErrorMessage(`Error writing to log file: ${logFilePath}`);
    }
}

// Function to update document statistics
function updateDocumentStats(doc: vscode.TextDocument) {
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    const totalContent = doc.getText();
    const totalLines = doc.lineCount;
    const totalChars = totalContent.length;
    
    // Calculate AI content
    let aiChars = 0;
    let aiLines = 0;
    
    if (aiGeneratedRegions.has(relPath)) {
        const regions = aiGeneratedRegions.get(relPath);
        if (regions) {
            for (const region of regions) {
                aiChars += region.text.length;
                aiLines += (region.endLine - region.startLine) + 1;
            }
        }
    }
    
    // Update document stats
    documentStats.set(relPath, {
        totalChars,
        totalLines,
        aiChars,
        aiLines
    });
}

// Function to check for deleted AI code
function checkForDeletedAICode(doc: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]) {
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    if (!aiGeneratedRegions.has(relPath)) {
        return;
    }
    
    const regions = aiGeneratedRegions.get(relPath) || [];
    const newRegions: typeof regions = [];
    const deletedRegions: typeof regions = [];
    
    // Check for deletions in each change
    for (const change of changes) {
        // If it's a deletion (no text inserted, some range deleted)
        if (change.text === '' && (change.range.start.line !== change.range.end.line || change.range.start.character !== change.range.end.character)) {
            for (const region of regions) {
                // Check if the deletion affects this region
                const changeStartsBeforeRegionEnds = (change.range.start.line < region.endLine) || 
                    (change.range.start.line === region.endLine && change.range.start.character <= region.endChar);
                    
                const changeEndsAfterRegionStarts = (change.range.end.line > region.startLine) ||
                    (change.range.end.line === region.startLine && change.range.end.character >= region.startChar);
                
                // If the change overlaps with the region, consider it a deletion
                if (changeStartsBeforeRegionEnds && changeEndsAfterRegionStarts) {
                    // This region was fully or partially deleted
                    if (!deletedAICode.has(relPath)) {
                        deletedAICode.set(relPath, []);
                    }
                    
                    deletedAICode.get(relPath)?.push({
                        id: region.id,
                        text: region.text,
                        deletedAt: Date.now(),
                        originalTimestamp: region.timestamp
                    });
                    
                    deletedRegions.push(region);
                    continue;
                }
            }
        }
    }
    
    // Keep only regions that weren't deleted
    for (const region of regions) {
        if (!deletedRegions.includes(region)) {
            newRegions.push(region);
        }
    }
    
    // Update the tracked regions
    if (newRegions.length > 0) {
        aiGeneratedRegions.set(relPath, newRegions);
    } else {
        aiGeneratedRegions.delete(relPath);
    }
    
    // Update document stats to reflect deletions
    updateDocumentStats(doc);
}

export function deactivate() {}