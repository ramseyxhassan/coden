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

export function activate(context: vscode.ExtensionContext) {
    console.log('Coden: Coden Tracker extension is now active');

    // Initialize status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(coden) Coden";
    statusBarItem.tooltip = "Tracking Coden suggestions";
    context.subscriptions.push(statusBarItem);

    // Update status bar visibility based on tracking state
    function updateStatusBar() {
        if (context.globalState.get('trackingEnabled')) {
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    }

    // Register commands
    let enableCommand = vscode.commands.registerCommand('coden.enableTracking', () => {
        vscode.window.showInformationMessage('Coden suggestion tracking enabled');
        context.globalState.update('trackingEnabled', true);
        updateStatusBar();
    });

    let disableCommand = vscode.commands.registerCommand('coden.disableTracking', () => {
        vscode.window.showInformationMessage('Coden suggestion tracking disabled');
        context.globalState.update('trackingEnabled', false);
        updateStatusBar();
    });

    // Add command to show stats
    let showStatsCommand = vscode.commands.registerCommand('coden.showStats', () => {
        showSuggestionStats(context);
    });

    context.subscriptions.push(enableCommand, disableCommand, showStatsCommand);

    // Initialize tracking by default
    if (context.globalState.get('trackingEnabled') === undefined) {
        context.globalState.update('trackingEnabled', true);
    }
    updateStatusBar();

    // Track document open events
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            recentlyOpenedDocuments.add(doc.uri.toString());
            // Cache the initial content
            documentContentCache.set(doc.uri.toString(), doc.getText());
            
            // Remove from recently opened after a short delay
            setTimeout(() => {
                recentlyOpenedDocuments.delete(doc.uri.toString());
            }, 1000);
        })
    );

    // Clean up cache when documents are closed
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => {
            documentContentCache.delete(doc.uri.toString());
        })
    );

    // Track document changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            // Only track if enabled
            if (!context.globalState.get('trackingEnabled')) {
                return;
            }

            const doc = event.document;
            const docUri = doc.uri.toString();
            
            // Skip if document was just opened
            if (recentlyOpenedDocuments.has(docUri)) {
                return;
            }

            // Skip logging changes to our own log file
            const fileName = path.basename(doc.fileName);
            if (fileName === LOG_FILE_NAME) {
                return;
            }

            // Skip Coden's output channel and other VS Code internal documents
            if (docUri.includes('GitHub.copilot') || docUri.includes('output:') || docUri.includes('extension-output')) {
                return;
            }

            // Get cached content
            const oldContent = documentContentCache.get(docUri) || '';
            const newContent = doc.getText();
            
            // Detect if changes likely came from Coden
            for (const change of event.contentChanges) {
                // Heuristics for Coden suggestions
                if (isProbablyCodenSuggestion(change.text, doc.languageId)) {
                    // Store language statistics for model inference
                    incrementLanguageCount(doc.languageId);
                    
                    logSuggestion(doc, change, oldContent, newContent);
                }
            }
            
            // Update cache with new content
            documentContentCache.set(docUri, newContent);
        })
    );

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

    // Update decorations when editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                updateDecorations(editor);
            }
        })
    );

    // Update decorations when document changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                updateDecorations(editor);
            }
        })
    );

    // Initial update for the active editor
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
    }
}

// Update decorations in the editor
function updateDecorations(editor: vscode.TextEditor) {
    // Check if highlighting is enabled (could be a setting in the future)
    const highlightEnabled = true;
    if (!highlightEnabled) {
        return;
    }

    // Get file path
    const filePath = editor.document.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(filePath);
    
    // Get AI-generated ranges
    const aiRanges = getAIGeneratedRanges(relativePath);
    
    // Set decorations
    editor.setDecorations(aiHoverDecorationType, aiRanges);
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
    
    // Read log file
    try {
        const fileContent = fs.readFileSync(logFilePath, 'utf8');
        const logData = JSON.parse(fileContent);
        
        if (logData.length === 0) {
            vscode.window.showInformationMessage('No Coden suggestions logged yet');
            return;
        }
        
        // Calculate statistics
        const totalSuggestions = logData.length;
        
        // Group by language
        const langStats: Record<string, number> = {};
        for (const entry of logData) {
            const lang = entry.language || 'unknown';
            langStats[lang] = (langStats[lang] || 0) + 1;
        }
        
        // Group by probable model
        const modelStats: Record<string, number> = {};
        for (const entry of logData) {
            const model = entry.metadata?.probableModel || 'unknown';
            modelStats[model] = (modelStats[model] || 0) + 1;
        }
        
        // Create stats panel
        const panel = vscode.window.createWebviewPanel(
            'codenStats',
            'Coden - Copilot Suggestion Stats',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        
        // Generate HTML content
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
                }
                h1, h2 {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 5px;
                }
                .stat-group {
                    margin-bottom: 20px;
                }
                .stat-item {
                    display: flex;
                    justify-content: space-between;
                    margin: 5px 0;
                }
                .stat-bar {
                    background-color: var(--vscode-button-background);
                    height: 20px;
                    margin-top: 5px;
                }
            </style>
        </head>
        <body>
            <h1>Coden - Copilot Suggestion Statistics</h1>
            <div class="stat-group">
                <h2>Overview</h2>
                <div class="stat-item">
                    <span>Total Suggestions:</span>
                    <span>${totalSuggestions}</span>
                </div>
            </div>
            
            <div class="stat-group">
                <h2>By Language</h2>
                ${Object.entries(langStats).map(([lang, count]) => {
                    const percentage = Math.round((count / totalSuggestions) * 100);
                    return `
                    <div class="stat-item">
                        <span>${lang}:</span>
                        <span>${count} (${percentage}%)</span>
                    </div>
                    <div class="stat-bar" style="width: ${percentage}%"></div>
                    `;
                }).join('')}
            </div>
            
            <div class="stat-group">
                <h2>By Model</h2>
                ${Object.entries(modelStats).map(([model, count]) => {
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

function isProbablyCodenSuggestion(text: string, languageId: string): boolean {
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
    // Ensure we have a workspace folder
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        console.log('No workspace folder found');
        return;
    }
    
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const logFilePath = path.join(workspaceRoot, LOG_FILE_NAME);
    
    // Generate unique ID for this suggestion
    const suggestionId = generateSuggestionId();
    
    // Extract surrounding code context (if available)
    let contextBefore = '';
    let contextAfter = '';
    try {
        const lines = doc.getText().split('\n');
        const startLine = Math.max(0, change.range.start.line - 3);
        const endLine = Math.min(lines.length - 1, change.range.end.line + 3);
        
        if (startLine < change.range.start.line) {
            contextBefore = lines.slice(startLine, change.range.start.line).join('\n');
            // Limit context size
            if (contextBefore.length > MAX_CONTEXT_SIZE) {
                contextBefore = contextBefore.substring(contextBefore.length - MAX_CONTEXT_SIZE);
            }
        }
        
        if (endLine > change.range.end.line) {
            contextAfter = lines.slice(change.range.end.line + 1, endLine + 1).join('\n');
            // Limit context size
            if (contextAfter.length > MAX_CONTEXT_SIZE) {
                contextAfter = contextAfter.substring(0, MAX_CONTEXT_SIZE);
            }
        }
    } catch (e) {
        // Ignore errors in context extraction
    }
    
    // Additional metadata
    const insertTime = new Date();
    const lineCount = change.text.split('\n').length;
    const estimatedTokens = Math.ceil(change.text.length / 4); // Rough estimate of tokens
    
    // Create log entry with improved metadata
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
        // Show indication in status bar that a suggestion was logged
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

export function deactivate() {}