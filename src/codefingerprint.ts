import * as crypto from 'crypto';

/**
 * Represents a fingerprint of code that can be used for tracking and identification
 */
export interface CodeFingerprint {
    // Raw hash for quick comparison
    hash: string;
    
    // Original code text (for reference)
    originalText: string;
    
    // Structural information
    lineCount: number;
    structuralElements: StructuralElement[];
    
    // Identifier information
    identifiers: string[];
    
    // Language-specific metadata
    language: string;
    
    // Semantic patterns
    semanticPatterns: string[];
}

/**
 * Represents a structural element in code (function, class, etc.)
 */
export interface StructuralElement {
    type: 'function' | 'class' | 'import' | 'variable' | 'other';
    name: string;
    pattern: string;
    importance: number; // 0-1 weight for tracking
}

/**
 * Generates a fingerprint for a code fragment
 */
export function generateCodeFingerprint(
    code: string, 
    language: string
): CodeFingerprint {
    // Create a hash of the code for quick comparisons
    const hash = crypto.createHash('md5').update(code).digest('hex');
    
    // Extract structural elements based on language
    const structuralElements = extractStructuralElements(code, language);
    
    // Extract identifiers
    const identifiers = extractSignificantIdentifiers(code);
    
    // Extract semantic patterns
    const semanticPatterns = extractSemanticPatterns(code, language);
    
    return {
        hash,
        originalText: code,
        lineCount: code.split('\n').length,
        structuralElements,
        identifiers,
        language,
        semanticPatterns
    };
}

/**
 * Extract structural elements from code
 */
function extractStructuralElements(code: string, language: string): StructuralElement[] {
    const elements: StructuralElement[] = [];
    
    // Extract imports (works for multiple languages)
    const importRegexes = {
        'typescript': /import\s+(?:{[^}]+}|[^{;]+)\s+from\s+['"]([^'"]+)['"]/g,
        'javascript': /import\s+(?:{[^}]+}|[^{;]+)\s+from\s+['"]([^'"]+)['"]/g,
        'python': /(?:from\s+([^\s]+)\s+import|import\s+([^\s]+))/g,
        'java': /import\s+([^;]+);/g,
        'csharp': /using\s+([^;]+);/g,
        'default': /import|using|include|require/g
    };
    
    const langRegex = importRegexes[language as keyof typeof importRegexes] || importRegexes.default;
    
    let match;
    while ((match = langRegex.exec(code)) !== null) {
        const importName = match[1] || match[0];
        elements.push({
            type: 'import',
            name: importName,
            pattern: match[0],
            importance: 0.5 // Imports are moderately important
        });
    }
    
    // Extract functions (basic pattern, would need to be enhanced per language)
    const functionRegex = /function\s+([a-zA-Z0-9_]+)\s*\(|([a-zA-Z0-9_]+)\s*=\s*function\s*\(|([a-zA-Z0-9_]+)\s*=\s*\([^)]*\)\s*=>|([a-zA-Z0-9_]+)\s*\([^)]*\)\s*{/g;
    while ((match = functionRegex.exec(code)) !== null) {
        const funcName = match[1] || match[2] || match[3] || match[4] || 'anonymous';
        elements.push({
            type: 'function',
            name: funcName,
            pattern: match[0],
            importance: 0.8 // Functions are very important
        });
    }
    
    // Extract classes (basic pattern)
    const classRegex = /class\s+([a-zA-Z0-9_]+)/g;
    while ((match = classRegex.exec(code)) !== null) {
        elements.push({
            type: 'class',
            name: match[1],
            pattern: match[0],
            importance: 0.9 // Classes are very important
        });
    }
    
    // Extract variable declarations (basic pattern)
    const varRegex = /(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=|([a-zA-Z0-9_]+)\s*:\s*[a-zA-Z0-9_<>[\]]+\s*=/g;
    while ((match = varRegex.exec(code)) !== null) {
        const varName = match[1] || match[2] || 'unknown';
        elements.push({
            type: 'variable',
            name: varName,
            pattern: match[0],
            importance: 0.6 // Variables are moderately important
        });
    }
    
    return elements;
}

/**
 * Extract significant identifiers from code
 */
function extractSignificantIdentifiers(code: string): string[] {
    // Get meaningful words/identifiers from text
    const identifierRegex = /\b([a-zA-Z][a-zA-Z0-9_]{2,})\b/g;
    const allMatches = code.match(identifierRegex) || [];
    
    // Filter out common keywords
    const commonKeywords = new Set([
        'function', 'class', 'const', 'let', 'var', 
        'return', 'if', 'else', 'for', 'while', 
        'import', 'export', 'from', 'require',
        'string', 'number', 'boolean', 'object', 'array',
        'true', 'false', 'null', 'undefined'
    ]);
    
    const significantIdentifiers = allMatches.filter(id => !commonKeywords.has(id));
    
    // Return unique identifiers
    return [...new Set(significantIdentifiers)];
}

/**
 * Extract semantic patterns from code
 */
function extractSemanticPatterns(code: string, language: string): string[] {
    const patterns: string[] = [];
    
    // Extract function calls
    const functionCallRegex = /\b([a-zA-Z][a-zA-Z0-9_]*)\s*\([^(]*\)/g;
    let match;
    while ((match = functionCallRegex.exec(code)) !== null) {
        if (match[1] && match[1].length > 2) {
            patterns.push(match[0]);
        }
    }
    
    // Extract property accesses
    const propertyAccessRegex = /\b([a-zA-Z][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z][a-zA-Z0-9_]*)/g;
    while ((match = propertyAccessRegex.exec(code)) !== null) {
        patterns.push(match[0]);
    }
    
    // Add code structure patterns
    if (code.includes('=>')) patterns.push('arrow_function');
    if (code.includes('class')) patterns.push('class_definition');
    if (code.includes('import')) patterns.push('import_statement');
    if (code.includes('async')) patterns.push('async_code');
    if (code.includes('try') && code.includes('catch')) patterns.push('error_handling');
    
    // Return unique patterns
    return [...new Set(patterns)];
}

/**
 * Check if a code fingerprint exists in current content
 */
export function checkCodeExistence(
    fingerprint: CodeFingerprint, 
    currentContent: string
): { exists: boolean; modified: boolean; confidence: number; matchDetails: any } {
    // Quick check - if the exact code exists, return high confidence
    if (currentContent.includes(fingerprint.originalText)) {
        return {
            exists: true,
            modified: false,
            confidence: 1.0,
            matchDetails: { type: 'exact_match' }
        };
    }
    
    // Detailed analysis
    const results = {
        // Check structural elements
        structuralMatches: checkStructuralElements(fingerprint.structuralElements, currentContent),
        
        // Check identifiers (with importance weighting)
        identifierMatches: checkIdentifiers(fingerprint.identifiers, currentContent),
        
        // Check semantic patterns
        patternMatches: checkPatterns(fingerprint.semanticPatterns, currentContent)
    };
    
    // Calculate confidence score
    const confidence = calculateConfidence(results, fingerprint);
    
    // Calculate existence threshold (adaptive based on code complexity)
    const existenceThreshold = calculateExistenceThreshold(fingerprint);
    const modificationThreshold = existenceThreshold + 0.2; // Higher bar for unmodified
    
    return {
        exists: confidence >= existenceThreshold,
        modified: confidence >= existenceThreshold && confidence < modificationThreshold,
        confidence,
        matchDetails: results
    };
}

/**
 * Check structural elements in current content
 */
function checkStructuralElements(elements: StructuralElement[], content: string): {
    found: StructuralElement[];
    notFound: StructuralElement[];
    overallScore: number;
} {
    const found: StructuralElement[] = [];
    const notFound: StructuralElement[] = [];
    
    // Check each structural element
    for (const element of elements) {
        const exists = content.includes(element.pattern);
        
        if (exists) {
            found.push(element);
        } else {
            notFound.push(element);
        }
    }
    
    // Calculate overall score
    const totalWeight = elements.reduce((sum, el) => sum + el.importance, 0);
    const foundWeight = found.reduce((sum, el) => sum + el.importance, 0);
    
    const overallScore = totalWeight > 0 ? foundWeight / totalWeight : 0;
    
    return { found, notFound, overallScore };
}

/**
 * Check identifiers in current content
 */
function checkIdentifiers(identifiers: string[], content: string): {
    found: string[];
    notFound: string[];
    overallScore: number;
} {
    const found: string[] = [];
    const notFound: string[] = [];
    
    // Check each identifier
    for (const id of identifiers) {
        if (content.includes(id)) {
            found.push(id);
        } else {
            notFound.push(id);
        }
    }
    
    // Calculate overall score
    const overallScore = identifiers.length > 0 ? found.length / identifiers.length : 0;
    
    return { found, notFound, overallScore };
}

/**
 * Check semantic patterns in current content
 */
function checkPatterns(patterns: string[], content: string): {
    found: string[];
    notFound: string[];
    overallScore: number;
} {
    const found: string[] = [];
    const notFound: string[] = [];
    
    // Check each pattern
    for (const pattern of patterns) {
        if (content.includes(pattern)) {
            found.push(pattern);
        } else {
            notFound.push(pattern);
        }
    }
    
    // Calculate overall score
    const overallScore = patterns.length > 0 ? found.length / patterns.length : 0;
    
    return { found, notFound, overallScore };
}

/**
 * Calculate confidence score from match results
 */
function calculateConfidence(
    results: any, 
    fingerprint: CodeFingerprint
): number {
    // Weight factors
    const weights = {
        structural: 0.5,
        identifier: 0.3,
        pattern: 0.2
    };
    
    // Calculate weighted score
    let weightedScore = 
        results.structuralMatches.overallScore * weights.structural +
        results.identifierMatches.overallScore * weights.identifier +
        results.patternMatches.overallScore * weights.pattern;
    
    // Adjust based on code complexity
    const complexityFactor = Math.min(1, 0.3 + (fingerprint.lineCount * 0.05));
    
    // More complex code is easier to track confidently
    weightedScore = weightedScore * complexityFactor;
    
    return Math.min(1, weightedScore);
}

/**
 * Calculate existence threshold based on code complexity
 */
function calculateExistenceThreshold(fingerprint: CodeFingerprint): number {
    // Base threshold
    let threshold = 0.3;
    
    // Adjust based on code complexity
    if (fingerprint.lineCount <= 1) {
        // Single-line code needs higher threshold
        threshold = 0.5;
    } else if (fingerprint.lineCount >= 10) {
        // Larger blocks can use lower threshold
        threshold = 0.2;
    }
    
    // Adjust based on element count
    const elementCount = fingerprint.structuralElements.length;
    if (elementCount === 0) {
        // If no structural elements, need higher threshold
        threshold += 0.1;
    } else if (elementCount >= 3) {
        // Many structural elements makes tracking easier
        threshold -= 0.1;
    }
    
    return Math.max(0.1, Math.min(0.7, threshold));
}
