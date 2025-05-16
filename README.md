# Coden

A VS Code extension that tracks GitHub Copilot code suggestions accepted by users.

![Coden Interface](images/Screenshot%202025-05-16%20180346.png)

## Features

- Automatically detects and logs Copilot suggestions
- Saves accepted suggestions to a local JSON file
- Commands to enable/disable tracking

## Requirements

- VS Code 1.60.0 or newer
- GitHub Copilot extension installed and active

## How it works

The extension monitors text changes in your editor and uses heuristics to identify when a change likely came from a Copilot suggestion. These accepted suggestions are logged to a JSON file in your workspace root.

## Extension Settings

* `coden.enableTracking`: Enable Copilot suggestion tracking
* `coden.disableTracking`: Disable Copilot suggestion tracking

![Extension in Action](images/Screenshot%202025-05-16%20180411.png)

## Demo

A screen recording demonstrating how Coden works is available in the images folder: [View Demo](images/Screen%20Recording%202025-05-09%20125703.mp4)

## Log Format

Suggestions are logged to `coden.json` in this format:

```json
[
  {
    "timestamp": "2025-04-20T21:00:21-05:00",
    "file": "src/example.js",
    "range": {
      "startLine": 10,
      "startChar": 2,
      "endLine": 10,
      "endChar": 2
    },
    "insertedText": "const exampleFunction = () => {\n  return 'Hello World';\n}",
    "lineCount": 3,
    "charCount": 57
  }
]
```

## Commands

```bash
npm install
npm install -g @vscode/vsce
npm run compile
vsce package
```

## Installation

1. Download the `.vsix` file from the latest release
2. Open VS Code and go to Extensions
3. Click on the `...` menu and select "Install from VSIX"
4. Choose the downloaded file and restart VS Code