import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Constants
 */
const EXTENSION_VERSION = '0.3.0';
const LOG_FILE_NAME = 'coden.json';
const MOD_LOG_FILE_NAME = 'coden_mod.json';
const MAX_CONTEXT_SIZE = 200;

/**
 * Interfaces for type safety
 */
interface AiRegion {
    id: string;
    startLine: number;
    endLine: number;
    startChar: number;
    endChar: number;
    text: string;
    timestamp: number;
    modified?: boolean;
    deleted?: boolean;
}

interface DocumentStats {
    totalChars: number;
    totalLines: number;
    aiChars: number;
    aiLines: number;
}

interface DeletedCode {
    id: string;
    text: string;
    deletedAt: number;
    originalTimestamp: number;
}

interface ModifiedCode {
    id: string;
    originalText: string;
    modifiedText: string;
    modifiedAt: number;
    originalTimestamp: number;
    confidenceScore: number;
    modType: string;
}

interface LogEntry {
    timestamp: string;
    id: string;
    file: string;
    language: string;
    range: {
        startLine: number;
        startChar: number;
        endLine: number;
        endChar: number;
    };
    insertedText: string;
    context: {
        before: string;
        after: string;
    };
    metadata: {
        lineCount: number;
        charCount: number;
        estimatedTokens: number;
        probableModel: string;
        insertedAt: {
            time: string;
            date: string;
            timestamp: number;
        };
        trackingToolVersion: string;
    };
}

interface ModificationData {
    [filePath: string]: {
        modifications: any[];
        deletions: any[];
    };
}

interface DocumentSnapshot {
    content: string;
    timestamp: number;
}

/**
 * State management
 */
// Track document content and changes
const documentContentCache = new Map<string, string>();
const recentlyOpenedDocuments = new Set<string>();
const documentSnapshots = new Map<string, DocumentSnapshot>();

// Track AI-generated code
const aiGeneratedRegions = new Map<string, AiRegion[]>();
const documentStats = new Map<string, DocumentStats>();
const deletedAICode = new Map<string, DeletedCode[]>();
const modifiedAICode = new Map<string, ModifiedCode[]>();

// Language statistics for model identification
const languageStats = new Map<string, number>();

// Status bar item
let statusBarItem: vscode.StatusBarItem;

// Decorations for AI-generated code
const aiHoverDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(65, 105, 225, 0.05)',
    border: '1px dashed rgba(65, 105, 225, 0.3)',
    borderRadius: '3px',
});

// Decorations for modified AI code
const aiModifiedDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(65, 105, 225, 0.05)',
    border: '1px dotted rgba(255, 140, 0, 0.4)',
    borderRadius: '3px',
});

/**
 * Activation function
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('Coden: Coden Tracker extension is now active');

    // Initialize status bar
    initializeStatusBar(context);

    // Register event handlers
    registerEventHandlers(context);

    // Register commands
    registerCommands(context);

    // Initialize decorations for active editor
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
    }
}

/**
 * Initialize the status bar
 */
function initializeStatusBar(context: vscode.ExtensionContext): void {
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
}

/**
 * Register event handlers
 */
function registerEventHandlers(context: vscode.ExtensionContext): void {
    // Track document open events
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(handleDocumentOpen)
    );

    // Track document changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (!context.globalState.get('trackingEnabled')) {
                return;
            }

            const doc = event.document;
            if (shouldSkipDocument(doc)) {
                return;
            }

            handleDocumentChange(doc, event.contentChanges);
        })
    );

    // Track document save events
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            if (!context.globalState.get('trackingEnabled')) {
                return;
            }

            if (shouldSkipDocument(document)) {
                return;
            }

            // Run comprehensive tracking on save
            trackAICodeChanges(document, true);
            
            // Update document snapshot
            documentSnapshots.set(vscode.workspace.asRelativePath(document.uri), {
                content: document.getText(),
                timestamp: Date.now()
            });
        })
    );

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

    // Set up interval for lighter periodic checking
    const intervalCheck = setInterval(() => {
        if (vscode.window.activeTextEditor && context.globalState.get('trackingEnabled')) {
            trackAICodeChanges(vscode.window.activeTextEditor.document, false);
        }
    }, 30000); // Every 30 seconds

    context.subscriptions.push({ dispose: () => clearInterval(intervalCheck) });

    // Register hover provider to show information about AI-generated code
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('*', {
            provideHover(document, position, token) {
                return provideHoverInfo(document, position);
            }
        })
    );
}

/**
 * Handle document open events
 */
function handleDocumentOpen(doc: vscode.TextDocument): void {
    const docUri = doc.uri.toString();
    recentlyOpenedDocuments.add(docUri);
    
    // Remove from tracking after a second
    setTimeout(() => {
        recentlyOpenedDocuments.delete(docUri);
    }, 1000);
    
    // Create initial document snapshot
    documentSnapshots.set(vscode.workspace.asRelativePath(doc.uri), {
        content: doc.getText(),
        timestamp: Date.now()
    });
}

/**
 * Register commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
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

    context.subscriptions.push(toggleCommand, showStatsCommand);
}

/**
 * Update status bar visibility based on tracking state
 */
function updateStatusBar(trackingEnabled: boolean): void {
    if (trackingEnabled) {
        statusBarItem.show();
    } else {
        statusBarItem.hide();
    }
}

/**
 * Function to handle document changes
 */
function handleDocumentChange(doc: vscode.TextDocument, contentChanges: readonly vscode.TextDocumentContentChangeEvent[]): void {
    const docUri = doc.uri.toString();
    
    if (recentlyOpenedDocuments.has(docUri)) {
        return;
    }

    const oldContent = documentContentCache.get(docUri) || '';
    const newContent = doc.getText();
    
    // First check if AI code was deleted or modified
    checkForAICodeChanges(doc, contentChanges);
    
    // Then check for new AI suggestions
    for (const change of contentChanges) {
        if (isProbablyCodenSuggestion(change.text, doc.languageId, doc, change.range)) {
            incrementLanguageCount(doc.languageId);
            
            logSuggestion(doc, change, oldContent, newContent);
        }
    }
    
    // Update document statistics regardless of whether AI code was added
    updateDocumentStats(doc);
    
    // Update cache with new content
    documentContentCache.set(docUri, newContent);
}

/**
 * Function to determine if we should skip tracking this document
 */
function shouldSkipDocument(doc: vscode.TextDocument): boolean {
    const docUri = doc.uri.toString();
    const fileName = path.basename(doc.fileName);
    
    return (
        fileName === LOG_FILE_NAME ||
        fileName === MOD_LOG_FILE_NAME ||
        docUri.includes('GitHub.copilot') ||
        docUri.includes('output:') ||
        docUri.includes('extension-output')
    );
}

/**
 * Apply decorations to AI-generated code
 */
function updateDecorations(editor: vscode.TextEditor): void {
    const docUri = editor.document.uri.toString();
    const relPath = vscode.workspace.asRelativePath(editor.document.uri);
    
    // No decorations if this file has no AI regions
    if (!aiGeneratedRegions.has(relPath)) {
        editor.setDecorations(aiHoverDecorationType, []);
        editor.setDecorations(aiModifiedDecorationType, []);
        return;
    }
    
    const regions = aiGeneratedRegions.get(relPath) || [];
    const normalDecorations: vscode.DecorationOptions[] = [];
    const modifiedDecorations: vscode.DecorationOptions[] = [];
    
    for (const region of regions) {
        // Create decoration ranges and options
        const decorationOptions = createDecorationForRegion(region);
        
        // Add to the appropriate decoration array
        if (region.modified) {
            modifiedDecorations.push(decorationOptions);
        } else {
            normalDecorations.push(decorationOptions);
        }
    }
    
    // Apply the decorations
    editor.setDecorations(aiHoverDecorationType, normalDecorations);
    editor.setDecorations(aiModifiedDecorationType, modifiedDecorations);
}

/**
 * Create decoration for a region
 */
function createDecorationForRegion(region: AiRegion): vscode.DecorationOptions {
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
    return {
        range,
        hoverMessage: new vscode.MarkdownString(
            `**AI-Generated Code${region.modified ? ' (Modified)' : ''}**\n\n` +
            `Inserted: ${new Date(region.timestamp).toLocaleString()}\n` +
            `ID: ${region.id}`
        )
    };
}

/**
 * Provide hover information for AI-generated code
 */
function provideHoverInfo(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
    // Only process if we have workspace folders
    if (!vscode.workspace.workspaceFolders) {
        return null;
    }
    
    // Get file path and convert to format matching our logs
    const filePath = document.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(filePath);
    
    // Check if we have AI data for this position
    const aiInfo = getAISuggestionAtPosition(relativePath, position.line);
    if (!aiInfo) {
        return null;
    }
    
    // Format timestamp for display
    const timestamp = new Date(aiInfo.timestamp);
    const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short'
    });
    
    // Create hover content with markdown
    const hoverContent = new vscode.MarkdownString();
    hoverContent.isTrusted = true;
    
    // Add status based on actual existence of code
    let statusMsg = "";
    if (aiInfo.deleted) {
        statusMsg = " (Deleted)";
    } else if (aiInfo.modified) {
        statusMsg = " (Modified)";
    }
    
    // Special message for imports
    if (isImportStatement(aiInfo.insertedText)) {
        if (aiInfo.importStatus) {
            if (aiInfo.importStatus.exists) {
                statusMsg = " (Import Verified)";
            } else if (aiInfo.deleted) {
                statusMsg = " (Import Deleted)";
            }
        }
    }
    
    hoverContent.appendMarkdown(`## AI-Generated Code${statusMsg}\n\n`);
    hoverContent.appendMarkdown(`**Model:** ${aiInfo.metadata.probableModel}\n\n`);
    hoverContent.appendMarkdown(`**Generated:** ${dateTimeFormat.format(timestamp)}\n\n`);
    hoverContent.appendMarkdown(`**Size:** ${aiInfo.metadata.lineCount} lines, ${aiInfo.metadata.charCount} characters\n\n`);
    
    if (aiInfo.metadata.estimatedTokens) {
        hoverContent.appendMarkdown(`**Tokens:** ~${aiInfo.metadata.estimatedTokens}\n\n`);
    }
    
    // Type information
    if (isImportStatement(aiInfo.insertedText)) {
        hoverContent.appendMarkdown(`**Type:** Import Statement\n\n`);
    }
    
    if (aiInfo.modified) {
        hoverContent.appendMarkdown(`**Status:** Modified since insertion\n\n`);
    }
    
    // Add a command link to show stats
    hoverContent.appendMarkdown(`[Show All AI Statistics](command:coden.showStats)`);
    
    return new vscode.Hover(hoverContent);
}

/**
 * Helper functions for text analysis
 */

/**
 * Check if text is a short, simple statement
 */
function isShortStatement(text: string): boolean {
    return text.trim().length < 30 && text.split('\n').length === 1;
}

/**
 * Extract significant tokens from text
 */
function extractSignificantTokens(text: string): string[] {
    // Get meaningful words/identifiers from text
    const tokens = text.match(/\b([a-zA-Z]\w*)\b/g) || [];
    return [...new Set(tokens)]; // Return unique tokens
}

/**
 * Check if statement content exists in the document
 */
function statementExistsInContent(statement: string, content: string): boolean {
    // If exact match exists, return true
    if (content.includes(statement.trim())) {
        return true;
    }
    
    // Otherwise, try to detect if significant parts exist
    const tokens = extractSignificantTokens(statement);
    if (tokens.length === 0) {
        return false;
    }
    
    // Count how many tokens are found in the content
    const foundTokens = tokens.filter(token => 
        token.length > 2 && // Ignore very short tokens
        content.includes(token)
    );
    
    // If most significant tokens are found, consider it existing
    return foundTokens.length >= Math.max(1, tokens.length * 0.6);
}

/**
 * Check if text is an import statement
 */
function isImportStatement(text: string): boolean {
    const normalizedText = text.trim();
    return normalizedText.startsWith('import ') ||
           normalizedText.startsWith('from ') ||
           normalizedText.startsWith('#include ') ||
           normalizedText.startsWith('using ') ||
           normalizedText.match(/^import\s+{/) !== null;
}

/**
 * Check if an import exists in content
 */
function importExistsInContent(importText: string, content: string): boolean {
    const importLine = importText.trim();
    
    // Direct match
    if (content.includes(importLine)) {
        return true;
    }
    
    // Handle different import formats
    const importMatches = importLine.match(/import\s+([^{\s]+|\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/);
    if (importMatches) {
        const moduleName = importMatches[2];
        // Check if any import from this module exists
        const regex = new RegExp(`import\\s+[^{\\s]+|\\{[^}]+\\}\\s+from\\s+['"]${moduleName}['"]`);
        return regex.test(content);
    }
    
    // Handle simple imports
    const simpleImport = importLine.match(/import\s+['"]([^'"]+)['"]/);
    if (simpleImport) {
        const moduleName = simpleImport[1];
        return content.includes(`import "${moduleName}"`) || content.includes(`import '${moduleName}'`);
    }
    
    // Try token-based checking for imports as a fallback
    return statementExistsInContent(importLine, content);
}

/**
 * Calculate string similarity
 */
function calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.includes(str2) || str2.includes(str1)) return 0.9;
    
    // Count matching characters
    let matches = 0;
    const minLength = Math.min(str1.length, str2.length);
    
    for (let i = 0; i < minLength; i++) {
        if (str1[i] === str2[i]) matches++;
    }
    
    return matches / Math.max(str1.length, str2.length);
}

/**
 * Normalize a line of code for comparison
 */
function normalizeLine(line: string): string {
    return line.trim()
        .replace(/\s+/g, ' ')      // Normalize whitespace
        .replace(/#.*$/, '')       // Remove Python comments
        .replace(/\/\/.*$/, '')    // Remove JS comments
        .replace(/^\s*import\s+/, 'import '); // Normalize imports
}

/**
 * Extract semantic anchors from code
 */
function extractSemanticAnchors(code: string): string[] {
    const anchors: string[] = [];
    
    // Extract structural patterns (like function definitions, class declarations, etc.)
    const structuralMatches = code.match(/\b(\w+)\s+(\w+)\s*\([^)]*\)/g) || [];
    anchors.push(...structuralMatches);
    
    // Extract variable-like declarations
    const declarationMatches = code.match(/\b(\w+)\s+(\w+)\s*=/g) || [];
    anchors.push(...declarationMatches);
    
    // Extract function/method calls
    const callMatches = code.match(/\b(\w+)\.\w+\(/g) || [];
    anchors.push(...callMatches);
    
    // Extract significant identifiers
    const tokens = extractSignificantTokens(code);
    anchors.push(...tokens.filter(t => t.length > 3)); // Only use longer identifiers as anchors
    
    return [...new Set(anchors)]; // Return unique anchors
}

/**
 * Find fuzzy matches of semantic anchors
 */
function findFuzzyAnchorMatch(text: string, anchor: string): { match: boolean, text: string } {
    // Try with simple variations
    const variations = [
        anchor,
        anchor.replace(/\s+/g, ' '),
        anchor.replace(/\([^)]*\)/, '()')
    ];
    
    for (const variant of variations) {
        if (text.includes(variant)) {
            return { match: true, text: variant };
        }
    }
    
    // Check for partial matches (for function calls)
    const fnNameMatch = anchor.match(/(\w+)\(/);
    if (fnNameMatch) {
        const fnName = fnNameMatch[1];
        const regex = new RegExp(`${fnName}\\([^)]*\\)`, 'g');
        const matches = text.match(regex);
        
        if (matches && matches.length > 0) {
            return { match: true, text: matches[0] };
        }
    }
    
    return { match: false, text: '' };
}

/**
 * Track AI code changes using different methods
 */

/**
 * Track line-by-line similarity
 */
function trackLineByLineSimilarity(document: vscode.TextDocument, region: AiRegion) {
    const currentText = document.getText();
    const currentLines = currentText.split('\n');
    const aiLines = region.text.split('\n');
    
    // Determine if this is a simple short statement or a complex block
    const isSimpleStatement = isShortStatement(region.text);
    
    const lineSurvival = aiLines.map((aiLine: string) => {
        const normalizedAiLine = normalizeLine(aiLine);
        if (normalizedAiLine.length < 5) return { exists: true, similarity: 1.0, line: aiLine };
        
        // For short statements, use more flexible matching with a lower threshold
        if (isSimpleStatement) {
            // Check if this line exists in any form in the current text
            const exists = statementExistsInContent(aiLine, currentText);
            return {
                exists,
                similarity: exists ? 0.9 : 0, 
                line: aiLine 
            };
        }
        
        // Find best matching line
        let bestMatch = { exists: false, similarity: 0, line: "" };
        
        for (const docLine of currentLines) {
            const normalizedDocLine = normalizeLine(docLine);
            const similarity = calculateSimilarity(normalizedAiLine, normalizedDocLine);
            
            if (similarity > bestMatch.similarity) {
                // Adjust threshold based on content length - shorter content needs higher similarity
                const similarityThreshold = 
                    normalizedAiLine.length < 10 ? 0.8 : // Shorter lines need higher similarity
                    normalizedAiLine.length < 20 ? 0.7 : // Medium lines use standard threshold
                    0.6;                                 // Longer lines can use lower threshold
                
                bestMatch = { 
                    exists: similarity > similarityThreshold,
                    similarity, 
                    line: docLine 
                };
            }
        }
        
        return bestMatch;
    });
    
    // Calculate overall survival rate and collect modifications
    const survivingLines = lineSurvival.filter((l: {exists: boolean}) => l.exists).length;
    
    // Adjust deletion threshold based on content type
    // Shorter content gets lower deletion threshold (harder to consider it deleted)
    const contentComplexity = aiLines.length + (region.text.length / 50);
    const deletionThreshold = Math.min(0.3, 0.05 + (contentComplexity * 0.02));
    
    const survivalRate = survivingLines / Math.max(1, aiLines.length);
    const modifications = lineSurvival
        .map((result: {exists: boolean, similarity: number, line: string}, i: number) => ({ 
            original: aiLines[i], 
            current: result.line, 
            similarity: result.similarity 
        }))
        .filter((mod: {original: string, current: string, similarity: number}) => 
            mod.similarity > 0.7 && mod.similarity < 0.95);
    
    return {
        method: "line-similarity",
        confidence: 0.7,
        survivalRate,
        modifications,
        modificationDetected: modifications.length > 0,
        deletionDetected: survivalRate < deletionThreshold
    };
}

/**
 * Track AI code changes using semantic anchors
 */
function trackSemanticAnchors(document: vscode.TextDocument, region: AiRegion) {
    const currentText = document.getText();
    const anchors = extractSemanticAnchors(region.text);
    
    // Determine if this is a short statement or complex code block
    const isSimpleStatement = isShortStatement(region.text);
    
    // If it's a simple statement, add significant tokens as anchors
    if (isSimpleStatement) {
        const tokens = extractSignificantTokens(region.text);
        for (const token of tokens) {
            if (token.length > 2 && !anchors.includes(token)) {
                anchors.push(token);
            }
        }
    }
    
    // Check for existence of each anchor
    const anchorResults = anchors.map(anchor => {
        // Check for exact match
        const exactMatch = currentText.includes(anchor);
        
        // If no exact match, check for fuzzy match
        let fuzzyMatch = false;
        let fuzzyAnchor = "";
        
        if (!exactMatch) {
            // For simple statements, use token-based matching
            if (isSimpleStatement) {
                // For short statements, consider it a match if most tokens exist
                if (statementExistsInContent(anchor, currentText)) {
                    fuzzyMatch = true;
                    fuzzyAnchor = `similar to "${anchor}"`;
                }
            }
            else if (anchor.length > 10) {
                // For longer anchors in complex code, use fuzzy matching
                const fuzzyResult = findFuzzyAnchorMatch(currentText, anchor);
                fuzzyMatch = fuzzyResult.match;
                fuzzyAnchor = fuzzyResult.text;
            }
        }
        
        return {
            anchor,
            exists: exactMatch || fuzzyMatch,
            modified: !exactMatch && fuzzyMatch,
            fuzzyAnchor
        };
    });
    
    // Calculate metrics with adjustment for content type
    const existingAnchors = anchorResults.filter(a => a.exists).length;
    const modifiedAnchors = anchorResults.filter(a => a.modified).length;
    const survivalRate = existingAnchors / Math.max(1, anchors.length);
    
    // Adjust deletion threshold based on content complexity
    const deletionThreshold = isSimpleStatement ? 0.1 : 0.2;
    
    // Higher confidence for simple statements with our token-based approach
    const confidenceValue = isSimpleStatement ? 0.85 : 0.8;
    
    return {
        method: "semantic-anchors",
        confidence: confidenceValue,
        survivalRate,
        modificationDetected: modifiedAnchors > 0,
        deletionDetected: survivalRate < deletionThreshold,
        modifications: anchorResults
            .filter(a => a.modified)
            .map(a => ({ 
                original: a.anchor, 
                current: a.fuzzyAnchor 
            }))
    };
}

/**
 * Compare document with snapshot (for save events)
 */
function compareWithSnapshot(document: vscode.TextDocument, region: AiRegion, snapshot: DocumentSnapshot) {
    const currentContent = document.getText();
    const previousContent = snapshot.content;
    
    // Determine if this is a simple short statement or complex code block
    const isSimpleStatement = isShortStatement(region.text);
    
    // Simple approach: Check if the region's text appears identically
    const originalExists = previousContent.includes(region.text.trim());
    
    // For short statements, use token-based existence checking 
    let currentExists = false;
    if (isSimpleStatement) {
        currentExists = statementExistsInContent(region.text, currentContent);
    } else {
        currentExists = currentContent.includes(region.text.trim());
    }
    
    // If it was in the previous snapshot but not in current, it's deleted
    const deleted = originalExists && !currentExists;
    
    // If the exact text doesn't exist but significant parts do, it's modified
    let modified = false;
    let modType = "unknown";
    
    if (!currentExists) {
        if (isSimpleStatement) {
            // For simple statements, check if significant tokens are present
            const tokens = extractSignificantTokens(region.text);
            if (tokens.length > 0) {
                const foundTokens = tokens.filter(token => 
                    token.length > 2 && currentContent.includes(token));
                
                // If at least one significant token exists, consider it modified
                modified = foundTokens.length > 0;
                modType = modified ? "statement_token_modified" : "unknown";
            }
        } else {
            // For complex code blocks, check for structural fragments
            const fragments = region.text.match(/\b(\w+)\s+(\w+)\s*\([^)]*\)/g) || [];
            
            // Check if these core fragments still exist
            modified = fragments.some((fragment: string) => currentContent.includes(fragment));
            
            // Try to identify the type of modification
            if (modified) {
                if (currentContent.length < previousContent.length) {
                    modType = "partial_deletion";
                } else if (currentContent.length > previousContent.length) {
                    modType = "addition_modification";
                } else {
                    modType = "content_change";
                }
            }
        }
    }
    
    // Adjust confidence based on complexity - simpler content is easier to analyze accurately
    const confidenceValue = isSimpleStatement ? 0.85 : 0.9;
    
    return {
        method: "snapshot",
        confidence: confidenceValue,
        modificationDetected: modified,
        deletionDetected: deleted,
        modType
    };
}

/**
 * Combine results from different tracking methods
 */
function combineTrackingResults(lineResults: any, semanticResults: any, snapshotResults: any) {
    // Calculate weighted scores
    const totalConfidence = 
        (lineResults.confidence + 
        semanticResults.confidence + 
        snapshotResults.confidence);
        
    const weightedModification = 
        (lineResults.modificationDetected * lineResults.confidence + 
        semanticResults.modificationDetected * semanticResults.confidence + 
        snapshotResults.modificationDetected * snapshotResults.confidence) / totalConfidence;
        
    const weightedDeletion = 
        (lineResults.deletionDetected * lineResults.confidence + 
        semanticResults.deletionDetected * semanticResults.confidence + 
        snapshotResults.deletionDetected * snapshotResults.confidence) / totalConfidence;
    
    return {
        modificationDetected: weightedModification > 0.5,
        deletionDetected: weightedDeletion > 0.5,
        confidence: totalConfidence / 3,
        modType: snapshotResults.modType || "unknown",
        // Combine all modifications detected
        modifications: [
            ...lineResults.modifications,
            ...semanticResults.modifications
        ]
    };
}

/**
 * Core tracking function that combines multiple approaches
 */
function trackAICodeChanges(document: vscode.TextDocument, onSave = false) {
    const docUri = document.uri;
    const relPath = vscode.workspace.asRelativePath(docUri);
    const currentContent = document.getText();
    
    // Load existing AI regions
    const regions = aiGeneratedRegions.get(relPath) || [];
    
    // Load or initialize modification tracking
    let modificationData = loadModificationData();
    if (!modificationData[relPath]) {
        modificationData[relPath] = {
            modifications: [],
            deletions: []
        };
    }
    
    // Track each region
    for (const region of regions) {
        // Check if this is an import statement for special handling
        const isImport = isImportStatement(region.text);
        
        // APPROACH 1: Line-by-line similarity check
        const lineResults = trackLineByLineSimilarity(document, region);
        
        // APPROACH 2: Semantic anchor check
        const semanticResults = trackSemanticAnchors(document, region);
        
        // APPROACH 3: Only if onSave=true, compare document snapshots
        let snapshotResults = { confidence: 0, modificationDetected: false, deletionDetected: false, modType: "unknown" };
        if (onSave && documentSnapshots.has(relPath)) {
            snapshotResults = compareWithSnapshot(document, region, documentSnapshots.get(relPath)!);
        }
        
        // For import statements, make a direct check for existence
        let importResults = { confidence: 0, modificationDetected: false, deletionDetected: false, modType: "unknown" };
        if (isImport) {
            const importExists = importExistsInContent(region.text, currentContent);
            importResults = {
                confidence: 0.95, // Very high confidence for direct import checking
                modificationDetected: false,
                deletionDetected: !importExists,
                modType: "import_check"
            };
        }
        
        // Combine results with weighted confidence
        let results;
        if (isImport) {
            // For imports, give high weight to the specialized import check
            const totalConfidence = 
                (lineResults.confidence + 
                semanticResults.confidence + 
                snapshotResults.confidence + 
                importResults.confidence);
                
            const weightedModification = 
                (lineResults.modificationDetected * lineResults.confidence + 
                semanticResults.modificationDetected * semanticResults.confidence + 
                snapshotResults.modificationDetected * snapshotResults.confidence +
                importResults.modificationDetected * importResults.confidence) / totalConfidence;
                
            const weightedDeletion = 
                (lineResults.deletionDetected * lineResults.confidence + 
                semanticResults.deletionDetected * semanticResults.confidence + 
                snapshotResults.deletionDetected * snapshotResults.confidence +
                importResults.deletionDetected * importResults.confidence) / totalConfidence;
                
            results = {
                modificationDetected: weightedModification > 0.5,
                deletionDetected: weightedDeletion > 0.7, // Higher threshold for import deletions
                confidence: totalConfidence / 4,
                modType: snapshotResults.modType || importResults.modType || "unknown",
                modifications: [
                    ...lineResults.modifications,
                    ...semanticResults.modifications
                ]
            };
        } else {
            // Use normal combined results for non-imports
            results = combineTrackingResults(lineResults, semanticResults, snapshotResults);
        }
        
        // Mark the region as modified in our tracking
        if (results.modificationDetected && !region.modified) {
            region.modified = true;
            
            // Record the modification
            recordModification(modificationData, relPath, region, results);
        }
        
        // If region was deleted, record it and remove from active tracking
        if (results.deletionDetected) {
            recordDeletion(modificationData, relPath, region, results);
            
            // Find the index of this region
            const regionIndex = regions.findIndex(r => r.id === region.id);
            if (regionIndex !== -1) {
                regions.splice(regionIndex, 1);
            }
        }
    }
    
    // Update the AI generated regions
    if (regions.length > 0) {
        aiGeneratedRegions.set(relPath, regions);
    } else {
        aiGeneratedRegions.delete(relPath);
    }
    
    // Save the modification data
    saveModificationData(modificationData);
    
    // For extra validation, run final validation to catch any false deletions
    performFinalValidation(modificationData);
    
    // Update document stats to reflect changes
    updateDocumentStats(document);
}

/**
 * Record a modification in the tracking data
 */
function recordModification(modificationData: ModificationData, relPath: string, region: AiRegion, results: any) {
    const modification = {
        id: region.id,
        originalTimestamp: region.timestamp,
        modificationTimestamp: Date.now(),
        originalText: region.text,
        detectedChanges: results.modifications.map((mod: any) => ({
            original: mod.original,
            current: mod.current,
            similarity: mod.similarity
        })),
        confidenceScore: results.confidence,
        modType: results.modType,
        lineRange: {
            originalStart: region.startLine,
            originalEnd: region.endLine
        }
    };
    
    // Add to the modification tracking
    modificationData[relPath].modifications.push(modification);
    
    // Add to the in-memory tracking for stats
    if (!modifiedAICode.has(relPath)) {
        modifiedAICode.set(relPath, []);
    }
    
    modifiedAICode.get(relPath)?.push({
        id: region.id,
        originalText: region.text,
        modifiedText: "", // We don't know the exact modified text
        modifiedAt: Date.now(),
        originalTimestamp: region.timestamp,
        confidenceScore: results.confidence,
        modType: results.modType
    });
}

/**
 * Record a deletion in the tracking data
 */
function recordDeletion(modificationData: ModificationData, relPath: string, region: AiRegion, results: any) {
    const deletion = {
        id: region.id,
        originalTimestamp: region.timestamp,
        deletionTimestamp: Date.now(),
        originalText: region.text,
        confidenceScore: results.confidence,
        lineRange: {
            originalStart: region.startLine,
            originalEnd: region.endLine
        }
    };
    
    // Add to the deletion tracking
    modificationData[relPath].deletions.push(deletion);
    
    // Add to the in-memory tracking for stats
    if (!deletedAICode.has(relPath)) {
        deletedAICode.set(relPath, []);
    }
    
    deletedAICode.get(relPath)?.push({
        id: region.id,
        text: region.text,
        deletedAt: Date.now(),
        originalTimestamp: region.timestamp
    });
}

/**
 * Load the modification tracking data
 */
function loadModificationData(): ModificationData {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return {};
    }
    
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const modLogFilePath = path.join(workspaceRoot, MOD_LOG_FILE_NAME);
    
    if (!fs.existsSync(modLogFilePath)) {
        return {};
    }
    
    try {
        const fileContent = fs.readFileSync(modLogFilePath, 'utf8');
        return JSON.parse(fileContent);
    } catch (error) {
        console.error('Error reading modification log file:', error);
        return {};
    }
}

/**
 * Save the modification tracking data
 */
function saveModificationData(data: ModificationData) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return;
    }
    
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const modLogFilePath = path.join(workspaceRoot, MOD_LOG_FILE_NAME);
    
    try {
        fs.writeFileSync(modLogFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error('Error writing to modification log file:', error);
    }
}

/**
 * Get all AI-generated ranges for a file
 */
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

/**
 * Get AI suggestion at a specific position
 */
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
                    // Check if this has been modified
                    const isModified = isAICodeModified(entry.id, relativePath);
                    
                    // Check if this has been deleted - for enhanced hover info
                    const isDeleted = isAICodeDeleted(entry.id, relativePath);
                    
                    // Special handling for imports - verify if the import actually exists
                    let importStatus = null;
                    if (isImportStatement(entry.insertedText)) {
                        // Read current file content
                        try {
                            const fullPath = path.join(workspaceRoot, relativePath);
                            if (fs.existsSync(fullPath)) {
                                const currentContent = fs.readFileSync(fullPath, 'utf8');
                                const importExists = importExistsInContent(entry.insertedText, currentContent);
                                importStatus = {
                                    exists: importExists,
                                    verified: true
                                };
                            }
                        } catch (error) {
                            console.error('Error checking import existence:', error);
                        }
                    }
                    
                    // Add modified flag to the entry
                    return {
                        ...entry,
                        modified: isModified,
                        deleted: isDeleted,
                        importStatus
                    };
                }
            }
        }
    } catch (error) {
        console.error('Error checking AI suggestion:', error);
    }
    
    return null;
}

/**
 * Check if AI code has been modified
 */
function isAICodeModified(id: string, relativePath: string): boolean {
    // Check in-memory modification tracking
    const modData = loadModificationData();
    if (modData[relativePath] && modData[relativePath].modifications) {
        return modData[relativePath].modifications.some((mod: any) => mod.id === id);
    }
    
    return false;
}

/**
 * Check if AI code has been deleted
 */
function isAICodeDeleted(id: string, relativePath: string): boolean {
    // Check in-memory deletion tracking
    const modData = loadModificationData();
    if (modData[relativePath] && modData[relativePath].deletions) {
        return modData[relativePath].deletions.some((del: any) => del.id === id);
    }
    
    return false;
}

/**
 * Function to increment language count
 */
function incrementLanguageCount(languageId: string) {
    const currentCount = languageStats.get(languageId) || 0;
    languageStats.set(languageId, currentCount + 1);
}

/**
 * Generate a unique ID for each suggestion
 */
function generateSuggestionId(): string {
    try {
        return crypto.randomUUID();
    } catch (e) {
        // Fallback for older Node.js versions
        return Date.now().toString() + Math.random().toString(36).substring(2);
    }
}

/**
 * Try to infer which model might have generated the code
 */
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

/**
 * Check if a change is probably a Coden suggestion
 */
function isProbablyCodenSuggestion(text: string, languageId: string, document: vscode.TextDocument, changeRange: vscode.Range): boolean {
    // Skip single character or very short insertions
    if (text.length <= 3) {
        return false;
    }
    
    // Check if this change overlaps with existing AI regions
    const docUri = document.uri;
    const relativePath = vscode.workspace.asRelativePath(docUri);
    const existingRegions = aiGeneratedRegions.get(relativePath) || [];
    
    // If this change is inside or overlaps with an existing AI region,
    // it's probably an edit to that region, not a new suggestion
    const isModifyingExistingRegion = existingRegions.some(region => {
        return (
            // Change starts within region
            (changeRange.start.line >= region.startLine && 
            changeRange.start.line <= region.endLine) ||
            // Change ends within region
            (changeRange.end.line >= region.startLine && 
            changeRange.end.line <= region.endLine) ||
            // Change encompasses region
            (changeRange.start.line <= region.startLine && 
            changeRange.end.line >= region.endLine)
        );
    });
    
    // If modifying existing region, don't count as new AI code
    if (isModifyingExistingRegion) {
        return false;
    }
    
    // Continue with standard heuristics
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

/**
 * Check for changes to AI code
 */
function checkForAICodeChanges(doc: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]) {
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    if (!aiGeneratedRegions.has(relPath)) {
        return;
    }
    
    const regions = aiGeneratedRegions.get(relPath) || [];
    
    // Check for modifications and deletions in each change
    for (const change of changes) {
        // If it's a deletion (no text inserted, some range deleted)
        const isDeletion = change.text === '' && 
            (change.range.start.line !== change.range.end.line || 
             change.range.start.character !== change.range.end.character);
        
        // If it's a modification (some text inserted, some range replaced)
        const isModification = change.text !== '' && 
            (change.range.start.line !== change.range.end.line || 
             change.range.start.character !== change.range.end.character);
        
        for (const region of regions) {
            // Check if the change affects this region
            const changeStartsBeforeRegionEnds = (change.range.start.line < region.endLine) || 
                (change.range.start.line === region.endLine && change.range.start.character <= region.endChar);
                
            const changeEndsAfterRegionStarts = (change.range.end.line > region.startLine) ||
                (change.range.end.line === region.startLine && change.range.end.character >= region.startChar);
            
            // If the change overlaps with the region
            if (changeStartsBeforeRegionEnds && changeEndsAfterRegionStarts) {
                // Track modification
                if (isModification) {
                    handleModification(relPath, region);
                }
                
                // Track deletion
                else if (isDeletion) {
                    handleDeletion(relPath, region, change);
                }
            }
        }
    }
    
    // Remove regions that were marked as deleted
    const updatedRegions = regions.filter(region => !region.deleted);
    if (updatedRegions.length > 0) {
        aiGeneratedRegions.set(relPath, updatedRegions);
    } else {
        aiGeneratedRegions.delete(relPath);
    }
    
    // Update modification tracking in file
    updateModificationTracking(relPath);
}

/**
 * Handle modification of AI code
 */
function handleModification(relPath: string, region: AiRegion) {
    // Mark the region as modified
    region.modified = true;
    
    // Track in modification data
    if (!modifiedAICode.has(relPath)) {
        modifiedAICode.set(relPath, []);
    }
    
    // Check if we already have a record of this modification
    const existingMod = modifiedAICode.get(relPath)?.find(mod => mod.id === region.id);
    if (!existingMod) {
        modifiedAICode.get(relPath)?.push({
            id: region.id,
            originalText: region.text,
            modifiedText: "", // We don't know the modified text exactly
            modifiedAt: Date.now(),
            originalTimestamp: region.timestamp,
            confidenceScore: 1.0,
            modType: "inline_edit"
        });
    }
}

/**
 * Handle deletion of AI code
 */
function handleDeletion(relPath: string, region: AiRegion, change: vscode.TextDocumentContentChangeEvent) {
    // Check if this is a full deletion of the region
    const isFullDeletion = 
        change.range.start.line <= region.startLine && 
        change.range.end.line >= region.endLine;
    
    if (isFullDeletion) {
        if (!deletedAICode.has(relPath)) {
            deletedAICode.set(relPath, []);
        }
        
        deletedAICode.get(relPath)?.push({
            id: region.id,
            text: region.text,
            deletedAt: Date.now(),
            originalTimestamp: region.timestamp
        });
        
        // Mark for removal from active tracking
        region.deleted = true;
    } else {
        // Partial deletion is a modification
        handleModification(relPath, region);
        
        // Update modification type
        const mod = modifiedAICode.get(relPath)?.find(m => m.id === region.id);
        if (mod) {
            mod.modType = "partial_deletion";
        }
    }
}

/**
 * Update modification tracking data in the file
 */
function updateModificationTracking(relPath: string) {
    const modificationData = loadModificationData();
    let hasChanges = false;
    
    if (!modificationData[relPath]) {
        modificationData[relPath] = {
            modifications: [],
            deletions: []
        };
    }
    
    // Add modifications
    modifiedAICode.get(relPath)?.forEach(mod => {
        const existingMod = modificationData[relPath].modifications.find((m: any) => m.id === mod.id);
        if (!existingMod) {
            modificationData[relPath].modifications.push({
                id: mod.id,
                originalTimestamp: mod.originalTimestamp,
                modificationTimestamp: mod.modifiedAt,
                originalText: mod.originalText,
                confidenceScore: mod.confidenceScore,
                modType: mod.modType
            });
            hasChanges = true;
        }
    });
    
    // Add deletions
    deletedAICode.get(relPath)?.forEach(del => {
        const existingDel = modificationData[relPath].deletions.find((d: any) => d.id === del.id);
        if (!existingDel) {
            modificationData[relPath].deletions.push({
                id: del.id,
                originalTimestamp: del.originalTimestamp,
                deletionTimestamp: del.deletedAt,
                originalText: del.text,
                confidenceScore: 1.0
            });
            hasChanges = true;
        }
    });
    
    // Save if we made changes
    if (hasChanges) {
        saveModificationData(modificationData);
    }
}

/**
 * Log a suggestion
 */
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
    
    // Get surrounding context
    const { contextBefore, contextAfter } = extractContext(doc, change);
    
    const insertTime = new Date();
    const lineCount = change.text.split('\n').length;
    const estimatedTokens = Math.ceil(change.text.length / 4);
    
    const logEntry: LogEntry = {
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
    
    // Track this AI region for future reference
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
    
    // Save the suggestion to the log file
    saveToLogFile(logFilePath, logEntry);
}

/**
 * Extract context before and after the change
 */
function extractContext(doc: vscode.TextDocument, change: vscode.TextDocumentContentChangeEvent): { contextBefore: string, contextAfter: string } {
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
        console.error('Error extracting context:', e);
    }
    
    return { contextBefore, contextAfter };
}

/**
 * Save a suggestion to the log file
 */
function saveToLogFile(logFilePath: string, logEntry: LogEntry) {
    // Load existing log or create new
    let logData: LogEntry[] = [];
    
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

/**
 * Update document statistics
 */
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
                // For modified regions, count with lower weight
                const modificationFactor = region.modified ? 0.7 : 1.0;
                aiChars += region.text.length * modificationFactor;
                aiLines += ((region.endLine - region.startLine) + 1) * modificationFactor;
            }
        }
    }
    
    // Update document stats
    documentStats.set(relPath, {
        totalChars,
        totalLines,
        aiChars: Math.round(aiChars),
        aiLines: Math.round(aiLines)
    });
}

/**
 * Extract significant identifiers from code
 */
function extractSignificantIdentifiers(code: string): string[] {
    const identifiers = [];
    
    // Match variable names
    const varMatches = code.match(/\b([a-zA-Z]\w+)\b/g) || [];
    
    // Filter out common keywords and short identifiers
    const keywords = new Set(['if', 'else', 'for', 'while', 'function', 'class', 'return', 'const', 'let', 'var', 'import', 'export']);
    
    for (const match of varMatches) {
        if (!keywords.has(match) && match.length > 2) {
            identifiers.push(match);
        }
    }
    
    return [...new Set(identifiers)]; // Return unique identifiers
}

/**
 * Final validation to check if deleted items still exist
 */
function performFinalValidation(modData: ModificationData) {
    // Skip if no workspace folders
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return;
    }
    
    // Process each file in the tracking data
    for (const filePath in modData) {
        if (!modData.hasOwnProperty(filePath) || !modData[filePath].deletions) {
            continue;
        }
        
        try {
            // Get the full file path
            const fullPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath);
            
            // Skip if file doesn't exist
            if (!fs.existsSync(fullPath)) {
                continue;
            }
            
            // Read the current content
            const currentContent = fs.readFileSync(fullPath, 'utf8');
            let changes = false;
            
            // Check each deleted item
            const validatedDeletions = modData[filePath].deletions.filter((deletion: any) => {
                const originalText = deletion.originalText || '';
                
                // Skip very short content
                if (originalText.length < 5) {
                    return true;
                }
                
                // Special handling for simple short statements
                const isSimpleStatement = isShortStatement(originalText);
                
                if (isSimpleStatement) {
                    // For short statements, use token-based existence checking
                    const exists = statementExistsInContent(originalText, currentContent);
                    
                    if (exists) {
                        console.log(`Short statement falsely marked as deleted still exists: ${originalText.trim()}`);
                        
                        // Initialize modifications if needed
                        if (!modData[filePath].modifications) {
                            modData[filePath].modifications = [];
                        }
                        
                        // Check if not already in modifications
                        if (!modData[filePath].modifications.some((mod: any) => mod.id === deletion.id)) {
                            // Move to modifications instead
                            modData[filePath].modifications.push({
                                id: deletion.id,
                                originalTimestamp: deletion.originalTimestamp,
                                modificationTimestamp: Date.now(),
                                originalText: deletion.originalText,
                                confidenceScore: 0.9, // High confidence for validated existence
                                modType: "statement_exists"
                            });
                            
                            changes = true;
                        }
                        
                        return false; // Remove from deletions
                    }
                    
                    // For simple statements, we need higher confidence to mark as deleted
                    if (deletion.confidenceScore < 0.7) {
                        // If confidence is low, don't mark it as deleted
                        return false;
                    }
                }
                
                // Standard validation for smaller items (<30 chars)
                if (originalText.length < 30) {
                    // For short items, use direct text matching with trimming
                    const trimmed = originalText.trim();
                    const exists = currentContent.includes(trimmed);
                    
                    if (exists) {
                        console.log(`Item falsely marked as deleted still exists: ${trimmed}`);
                        
                        // Initialize modifications if needed
                        if (!modData[filePath].modifications) {
                            modData[filePath].modifications = [];
                        }
                        
                        // Check if not already in modifications
                        if (!modData[filePath].modifications.some((mod: any) => mod.id === deletion.id)) {
                            // Move to modifications instead
                            modData[filePath].modifications.push({
                                id: deletion.id,
                                originalTimestamp: deletion.originalTimestamp,
                                modificationTimestamp: Date.now(),
                                originalText: deletion.originalText,
                                confidenceScore: 0.8,
                                modType: "content_exists"
                            });
                            
                            changes = true;
                        }
                        
                        return false; // Remove from deletions
                    }
                }
                
                // For longer items, use identifier matching
                const identifiers = extractSignificantTokens(originalText);
                if (identifiers.length >= 2) {
                    // Consider it existing if a significant percentage of identifiers are found
                    const foundIdentifiers = identifiers.filter((id: string) => 
                        currentContent.includes(id) && id.length > 3
                    );
                    
                    const threshold = 0.6; // 60% of identifiers need to be found
                    const significantMatch = foundIdentifiers.length >= Math.max(2, identifiers.length * threshold);
                    
                    if (significantMatch) {
                        console.log(`Content with identifiers falsely marked as deleted: ${foundIdentifiers.join(', ')}`);
                        
                        // Initialize modifications if needed
                        if (!modData[filePath].modifications) {
                            modData[filePath].modifications = [];
                        }
                        
                        // Check if not already in modifications
                        if (!modData[filePath].modifications.some((mod: any) => mod.id === deletion.id)) {
                            // Move to modifications instead
                            modData[filePath].modifications.push({
                                id: deletion.id,
                                originalTimestamp: deletion.originalTimestamp,
                                modificationTimestamp: Date.now(),
                                originalText: deletion.originalText,
                                confidenceScore: 0.7,
                                modType: "identifiers_found"
                            });
                            
                            changes = true;
                        }
                        
                        return false; // Remove from deletions
                    }
                }
                
                return true; // Keep in deletions
            });
            
            // Update deletions if changes were made
            if (changes && validatedDeletions.length !== modData[filePath].deletions.length) {
                modData[filePath].deletions = validatedDeletions;
                console.log(`Final validation fixed tracking issues in ${filePath}`);
            }
        } catch (error) {
            console.error(`Error in final validation for ${filePath}:`, error);
        }
    }
}

/**
 * Final reconciliation before showing statistics
 */
function reconcileTrackingData(modificationData: ModificationData): ModificationData {
    // Create a deep copy to avoid modifying the original directly
    const reconciled = JSON.parse(JSON.stringify(modificationData));
    
    // Process each file
    for (const filePath in reconciled) {
        if (!reconciled.hasOwnProperty(filePath)) continue;
        
        const fileData = reconciled[filePath];
        
        // Skip if no modifications or deletions
        if (!fileData.modifications || !fileData.deletions) continue;
        
        // Run special validation for short statements
        validateShortStatementReconciliation(fileData, filePath);
        
        // 1. Handle double-tracking: no item should be both modified and deleted
        const modifiedIds = new Set(fileData.modifications.map((mod: any) => mod.id));
        
        // Remove any items from deletions that are also in modifications
        fileData.deletions = fileData.deletions.filter((del: any) => {
            // Keep items with finalStatus="deleted" in both lists, but mark appropriately
            const modIndex = fileData.modifications.findIndex((mod: any) => mod.id === del.id);
            if (modIndex !== -1) {
                // Update the modification to reflect deletion if not already done
                if (!fileData.modifications[modIndex].finalStatus) {
                    fileData.modifications[modIndex].finalStatus = "deleted";
                }
                
                // Was modified then deleted - more accurate to count as deletion only
                const wasModifiedThenDeleted = 
                    fileData.modifications[modIndex].modificationTimestamp < del.deletionTimestamp;
                
                // If modified then deleted within a short time window, consider it just deleted
                const timeThreshold = 10000; // 10 seconds 
                const isQuickChange = 
                    del.deletionTimestamp - fileData.modifications[modIndex].modificationTimestamp < timeThreshold;
                
                // For short statements or other short blocks that might still exist,
                // prefer to count them as modified rather than deleted when in doubt
                const isShortBlock = fileData.modifications[modIndex].originalText && 
                                    isShortStatement(fileData.modifications[modIndex].originalText);
                
                // Prioritize modifications over deletions for short statements if confidence is higher
                if (isShortBlock && fileData.modifications[modIndex].confidenceScore > del.confidenceScore) {
                    // Keep this in modifications, remove from deletions
                    return false;
                }
                
                // Remove from modifications if quick deletion after modification
                // and not a short statement
                if (wasModifiedThenDeleted && isQuickChange && !isShortBlock) {
                    // This is temporary - will be applied to the display only
                    modifiedIds.delete(del.id);
                }
                
                return false; // Remove from deletions
            }
            return true;
        });
        
        // For statistics purposes, filter modifications to exclude those marked as temporary
        fileData._filteredModifications = fileData.modifications.filter((mod: any) => modifiedIds.has(mod.id));
    }
    
    return reconciled;
}

/**
 * Additional validation specifically for short statements
 */
function validateShortStatementReconciliation(fileData: any, filePath: string) {
    if (!vscode.workspace.workspaceFolders) return;
    
    try {
        // Get the full file path
        const fullPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath);
        
        // Skip if file doesn't exist
        if (!fs.existsSync(fullPath)) return;
        
        // Read current content
        const currentContent = fs.readFileSync(fullPath, 'utf8');
        
        // Check deleted short statements that might still exist
        if (fileData.deletions) {
            fileData.deletions = fileData.deletions.filter((del: any) => {
                if (!del.originalText) return true;
                
                // Check if this is a short statement
                const isShortStatement = del.originalText.trim().length < 30 && 
                                        del.originalText.split('\n').length === 1;
                
                if (isShortStatement) {
                    // Check if it still exists using token-based checking
                    const stillExists = statementExistsInContent(del.originalText, currentContent);
                    
                    if (stillExists) {
                        // Move to modifications
                        if (!fileData.modifications) {
                            fileData.modifications = [];
                        }
                        
                        if (!fileData.modifications.some((mod: any) => mod.id === del.id)) {
                            fileData.modifications.push({
                                id: del.id,
                                originalTimestamp: del.originalTimestamp,
                                modificationTimestamp: Date.now(),
                                originalText: del.originalText,
                                confidenceScore: 0.9,
                                modType: "statement_verified_exists"
                            });
                        }
                        
                        return false; // Remove from deletions
                    }
                }
                
                return true;
            });
        }
    } catch (error) {
        console.error(`Error in statement validation for ${filePath}:`, error);
    }
}

/**
 * Show statistics about Coden suggestions
 */
function showSuggestionStats(context: vscode.ExtensionContext) {
    // Ensure we have a workspace folder
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }
    
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const logFilePath = path.join(workspaceRoot, LOG_FILE_NAME);
    const modLogFilePath = path.join(workspaceRoot, MOD_LOG_FILE_NAME);
    
    // Check if log file exists
    if (!fs.existsSync(logFilePath)) {
        vscode.window.showInformationMessage('No Coden suggestions logged yet');
        return;
    }
    
    try {
        const fileContent = fs.readFileSync(logFilePath, 'utf8');
        const logData = JSON.parse(fileContent);
        
        // Load modification data if available
        let modData: any = {};
        if (fs.existsSync(modLogFilePath)) {
            const modContent = fs.readFileSync(modLogFilePath, 'utf8');
            modData = JSON.parse(modContent);
        }
        
        // Reconcile tracking data to prevent double-counting
        modData = reconcileTrackingData(modData);
        
        // Final validation to fix any incorrect deletions
        performFinalValidation(modData);
        
        if (logData.length === 0) {
            vscode.window.showInformationMessage('No Coden suggestions logged yet');
            return;
        }
        
        // Calculate statistics
        const { totalSuggestions, totalCharacters, totalLines, modifiedCount, deletedCount,
                langStats, fileStats, modelStats, dateStats } = calculateStatistics(logData, modData);
        
        // Sort data for display
        const sortedLangEntries = Object.entries(langStats).sort((a, b) => b[1].count - a[1].count);
        const sortedFileEntries = Object.entries(fileStats).sort((a, b) => b[1].count - a[1].count);
        
        // Create and show the webview panel
        createStatsWebview(
            totalSuggestions, totalCharacters, totalLines, modifiedCount, deletedCount,
            sortedLangEntries, sortedFileEntries, modelStats
        );
        
    } catch (error) {
        vscode.window.showErrorMessage(`Error reading log file: ${error}`);
    }
}

/**
 * Calculate statistics from log data
 */
function calculateStatistics(logData: any[], modData: any) {
    const totalSuggestions = logData.length;
    let totalCharacters = 0;
    let totalLines = 0;
    let modifiedCount = 0;
    let deletedCount = 0;
    
    // Group by language
    const langStats: Record<string, {count: number, chars: number, lines: number}> = {};
    
    // Group by file
    const fileStats: Record<string, {
        count: number, 
        chars: number, 
        language: string, 
        lines: number, 
        aiChars: number, 
        aiLines: number, 
        totalChars: number, 
        totalLines: number, 
        aiPercentage: number,
        modified: number,
        deleted: number
    }> = {};
    
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
            fileStats[file] = {
                count: 0, 
                chars: 0, 
                language: lang, 
                lines: 0, 
                aiChars: 0, 
                aiLines: 0, 
                totalChars: 0, 
                totalLines: 0, 
                aiPercentage: 0,
                modified: 0,
                deleted: 0
            };
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
        
        // Check if this entry has been modified
        if (modData[file] && modData[file].modifications) {
            const isModified = modData[file].modifications.some((mod: any) => mod.id === entry.id);
            if (isModified) {
                modifiedCount++;
                if (fileStats[file]) {
                    fileStats[file].modified++;
                }
            }
        }
        
        // Check if this entry has been deleted
        if (modData[file] && modData[file].deletions) {
            const isDeleted = modData[file].deletions.some((del: any) => del.id === entry.id);
            if (isDeleted) {
                deletedCount++;
                if (fileStats[file]) {
                    fileStats[file].deleted++;
                }
            }
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
                aiPercentage: stats.totalChars > 0 ? (stats.aiChars / stats.totalChars) * 100 : 0,
                modified: 0,
                deleted: 0
            };
        }
    }
    
    return { 
        totalSuggestions, totalCharacters, totalLines, modifiedCount, deletedCount,
        langStats, fileStats, modelStats, dateStats
    };
}

/**
 * Create and show the statistics webview panel
 */
function createStatsWebview(
    totalSuggestions: number, totalCharacters: number, totalLines: number, 
    modifiedCount: number, deletedCount: number,
    sortedLangEntries: [string, any][],
    sortedFileEntries: [string, any][],
    modelStats: Record<string, number>
) {
    const panel = vscode.window.createWebviewPanel(
        'CodenStats',
        'Coden - Copilot Suggestion Stats',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    
    panel.webview.html = getStatsHtml(
        totalSuggestions, totalCharacters, totalLines, modifiedCount, deletedCount,
        sortedLangEntries, sortedFileEntries, modelStats
    );
}

/**
 * Generate the HTML for the statistics webview
 */
function getStatsHtml(
    totalSuggestions: number, totalCharacters: number, totalLines: number, 
    modifiedCount: number, deletedCount: number,
    sortedLangEntries: [string, any][],
    sortedFileEntries: [string, any][],
    modelStats: Record<string, number>
): string {
    return `
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
            .stat-bar.modified {
                background-color: #FF8C00;
            }
            .stat-bar.deleted {
                background-color: #FF4500;
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
            .badge {
                display: inline-block;
                padding: 2px 6px;
                border-radius: 10px;
                font-size: 0.8em;
                margin-left: 5px;
            }
            .badge.modified {
                background-color: #FF8C00;
                color: white;
            }
            .badge.deleted {
                background-color: #FF4500;
                color: white;
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
            <div class="tab" onclick="switchTab('modifications')">Modifications</div>
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
            
            <div class="two-columns">
                <div class="card">
                    <h3>Modified Suggestions</h3>
                    <div class="big-number">${modifiedCount}</div>
                    <div class="stat-detail">${Math.round((modifiedCount / totalSuggestions) * 100)}% of all suggestions</div>
                </div>
                <div class="card">
                    <h3>Deleted Suggestions</h3>
                    <div class="big-number">${deletedCount}</div>
                    <div class="stat-detail">${Math.round((deletedCount / totalSuggestions) * 100)}% of all suggestions</div>
                </div>
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
                    <th>Status</th>
                </tr>
                ${sortedFileEntries.slice(0, 5).map(([file, stats]) => `
                    <tr>
                        <td>${file}</td>
                        <td>${stats.language}</td>
                        <td>${stats.count}</td>
                        <td>${stats.chars.toLocaleString()}</td>
                        <td>
                            ${stats.modified > 0 ? `<span class="badge modified">${stats.modified} Modified</span>` : ''}
                            ${stats.deleted > 0 ? `<span class="badge deleted">${stats.deleted} Deleted</span>` : ''}
                        </td>
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
                        <div class="stat-item">
                            <span>Modified Suggestions:</span>
                            <span>${stats.modified} (${stats.count > 0 ? Math.round((stats.modified / stats.count) * 100) : 0}%)</span>
                        </div>
                        <div class="stat-item">
                            <span>Deleted Suggestions:</span>
                            <span>${stats.deleted} (${stats.count > 0 ? Math.round((stats.deleted / stats.count) * 100) : 0}%)</span>
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
        
        <div id="modifications" class="tab-content">
            <h2>Modification Statistics</h2>
            
            <div class="two-columns">
                <div class="card">
                    <h3>Modified Suggestions</h3>
                    <div class="big-number">${modifiedCount}</div>
                    <div class="stat-detail">${Math.round((modifiedCount / totalSuggestions) * 100)}% of all suggestions</div>
                </div>
                <div class="card">
                    <h3>Deleted Suggestions</h3>
                    <div class="big-number">${deletedCount}</div>
                    <div class="stat-detail">${Math.round((deletedCount / totalSuggestions) * 100)}% of all suggestions</div>
                </div>
            </div>
            
            <h3>Modification Rate by File</h3>
            <div class="stat-group">
                ${sortedFileEntries.filter(([_, stats]) => stats.modified > 0 || stats.deleted > 0).map(([file, stats]) => {
                    const modifiedPercentage = stats.count > 0 ? Math.round((stats.modified / stats.count) * 100) : 0;
                    const deletedPercentage = stats.count > 0 ? Math.round((stats.deleted / stats.count) * 100) : 0;
                    return `
                    <div class="stat-item">
                        <span>${file}:</span>
                        <span>
                            <span class="badge modified">${stats.modified} (${modifiedPercentage}%)</span>
                            <span class="badge deleted">${stats.deleted} (${deletedPercentage}%)</span>
                        </span>
                    </div>
                    <div style="display: flex; width: 100%;">
                        <div class="stat-bar modified" style="width: ${modifiedPercentage}%"></div>
                        <div class="stat-bar deleted" style="width: ${deletedPercentage}%"></div>
                    </div>
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
}

/**
 * Extension deactivation function
 */
export function deactivate() {
    // Clean up resources if needed
}