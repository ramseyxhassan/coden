import { CodeFingerprint, generateCodeFingerprint, checkCodeExistence } from './codefingerprint';
import * as vscode from 'vscode';

/**
 * Tracks changes to AI-generated code
 */
export interface CodeTrackingResult {
    // Whether the code exists (not deleted)
    exists: boolean;
    
    // Whether the code was modified
    modified: boolean;
    
    // Confidence level in this result (0-1)
    confidence: number;
    
    // Type of change detected
    changeType: 'unchanged' | 'modified' | 'deleted' | 'unknown';
    
    // Details about the changes
    details: any;
}

/**
 * Region of AI-generated code that's being tracked
 */
export interface TrackedCodeRegion {
    // Unique identifier
    id: string;
    
    // Document region
    startLine: number;
    endLine: number;
    startChar: number;
    endChar: number;
    
    // Code content
    text: string;
    
    // When it was inserted
    timestamp: number;
    
    // Tracking data
    fingerprint: CodeFingerprint;
    
    // Status flags
    modified?: boolean;
    deleted?: boolean;
    
    // Last detection results
    lastTrackingResult?: CodeTrackingResult;
}

/**
 * Track changes to AI-generated code
 */
export function trackCodeChanges(
    document: vscode.TextDocument,
    region: TrackedCodeRegion
): CodeTrackingResult {
    const currentContent = document.getText();
    
    // If we don't have a fingerprint yet, generate one
    if (!region.fingerprint) {
        region.fingerprint = generateCodeFingerprint(region.text, document.languageId);
    }
    
    // Check if the code exists
    const existenceResult = checkCodeExistence(region.fingerprint, currentContent);
    
    // Determine change type
    let changeType: 'unchanged' | 'modified' | 'deleted' | 'unknown' = 'unknown';
    
    if (existenceResult.exists) {
        changeType = existenceResult.modified ? 'modified' : 'unchanged';
    } else {
        changeType = 'deleted';
    }
    
    const result: CodeTrackingResult = {
        exists: existenceResult.exists,
        modified: existenceResult.modified,
        confidence: existenceResult.confidence,
        changeType,
        details: existenceResult.matchDetails
    };
    
    // Update region with result
    region.lastTrackingResult = result;
    region.modified = result.modified;
    region.deleted = !result.exists;
    
    return result;
}

/**
 * Track changes across multiple AI-generated regions
 */
export function trackAllCodeChanges(
    document: vscode.TextDocument,
    regions: TrackedCodeRegion[]
): Map<string, CodeTrackingResult> {
    const results = new Map<string, CodeTrackingResult>();
    
    for (const region of regions) {
        const result = trackCodeChanges(document, region);
        results.set(region.id, result);
    }
    
    return results;
}

/**
 * Create a tracked code region
 */
export function createTrackedRegion(
    id: string,
    document: vscode.TextDocument,
    range: vscode.Range,
    text: string,
    timestamp: number
): TrackedCodeRegion {
    const fingerprint = generateCodeFingerprint(text, document.languageId);
    
    return {
        id,
        startLine: range.start.line,
        endLine: range.end.line,
        startChar: range.start.character,
        endChar: range.end.character,
        text,
        timestamp,
        fingerprint
    };
}

/**
 * Convert AI region to tracked region for compatibility with existing code
 */
export function convertToTrackedRegion(
    region: any, 
    language: string
): TrackedCodeRegion {
    // Generate fingerprint if needed
    const fingerprint = generateCodeFingerprint(region.text, language);
    
    return {
        id: region.id,
        startLine: region.startLine,
        endLine: region.endLine,
        startChar: region.startChar,
        endChar: region.endChar,
        text: region.text,
        timestamp: region.timestamp,
        fingerprint,
        modified: region.modified,
        deleted: region.deleted
    };
}
