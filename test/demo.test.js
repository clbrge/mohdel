import { expect, test, describe, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { promisify } from 'util'
import * as dotenv from 'dotenv'
import modhel from '../src/index.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MODEL = `claude-3-7-sonnet-latest`
const LLM_KEY = 'ANTHROPIC_API_KEY'
const DEMO_PROMPT = `
I need help creating a minimal code assistant in one monolithic Nodejs script that can analyze source files and answer questions about them. The assistant should:

    1. Read one or more files provided as command-line arguments
    2. Create a preprompt with the file contents formatted in proper markdown code blocks to preserve syntax, with each file path clearly labeled as a level 2 heading before its content
    3. Allow the user to ask a question about the code via the terminal
    4. Include a specific post-prompt instructions to the LLM that when suggesting file changes, it must:
       - Output COMPLETE file contents (not just the changed parts)
       - Format each file replacement in a consistent, parseable pattern (markdown code blocks with the filename as a level 2 heading)
    5. Use the Anthropic Claude API (model ${MODEL}) to generate responses based on the code and user question
    6. Parse the LLM's answer to detect new file versions by looking for specific patterns in the markdown format
    7. When one or more new file versions are detected save the updated version without user confirmation (but copy the original with the suffix .orig)
    8. Implement minimal error handling for file operations, API calls, and user input

Please provide a complete implementation using ES modules with:
    - A simple terminal-based interface with clear user prompts
    - Environment variable configuration ANTHROPIC_API_KEY for the API key
    - No external dependencies besides dotenv and the Anthropic SDK (@anthropic-ai/sdk)
Ensure the code follows modern JavaScript practices including async/await for asynchronous operations and proper command-line argument parsing.
`

describe('modhel demo', () => {
  // Get custom output dir from environment, or use default
  const customOutputDir = process.env.TEST_OUTPUT_DIR
  const outputDir = customOutputDir || path.join(__dirname, '../test-output')
  const outputScriptPath = path.join(outputDir, 'code-assistant.js')
  let completionResult = ''
  
  // Get the project root directory for module resolution
  const projectRoot = path.resolve(__dirname, '..')
  const nodeModulesPath = path.join(projectRoot, 'node_modules')

  beforeAll(async () => {
    // Ensure test output directory exists
    await fs.mkdir(outputDir, { recursive: true })
    console.log(`Using test output directory: ${outputDir}`)
    
    // Create a symlink to the node_modules directory in the output directory
    // This ensures the generated script can find its dependencies
    const outputNodeModules = path.join(outputDir, 'node_modules')
    try {
      // Check if symlink already exists
      await fs.access(outputNodeModules)
    } catch (err) {
      // Create symlink if it doesn't exist
      try {
        await fs.symlink(nodeModulesPath, outputNodeModules, 'junction')
        console.log(`Created symlink from ${nodeModulesPath} to ${outputNodeModules}`)
      } catch (linkErr) {
        console.warn(`Warning: Could not create symlink to node_modules: ${linkErr.message}`)
        // If symlink fails, try copying package.json to allow npm install
        const packageJsonPath = path.join(projectRoot, 'package.json')
        const outputPackageJson = path.join(outputDir, 'package.json')
        try {
          await fs.copyFile(packageJsonPath, outputPackageJson)
          console.log(`Copied package.json to ${outputDir}`)
        } catch (copyErr) {
          console.warn(`Warning: Could not copy package.json: ${copyErr.message}`)
        }
      }
    }
  })

  afterAll(async () => {
    // Clean up test files (optional - you might want to keep them for debugging)
    // await fs.rm(outputDir, { recursive: true, force: true })
  })

  test('it\'s allowed should get a completion response that includes a JavaScript script', async () => {
    // You might want to mock this in a real test environment
    const llm = modhel(MODEL)
    completionResult = await llm.completion(DEMO_PROMPT)

    console.log({ completionResult })

    // Verify we got a non-empty response
    expect(completionResult).toBeTruthy()
    expect(typeof completionResult).toBe('string')
    expect(completionResult.length).toBeGreaterThan(100)
    
    // Check if it contains a code block with JavaScript
    const jsCodeBlockRegex = /```(js|javascript)?\n([\s\S]*?)\n```/
    const match = completionResult.match(jsCodeBlockRegex)
    
    expect(match).toBeTruthy()
    expect(match[2]).toBeTruthy()
    expect(match[2].length).toBeGreaterThan(100)
    
    // Extract and save the script to test it later
    const jsCode = match[2]
    await fs.writeFile(outputScriptPath, jsCode)
    
    return true
  }, 60000) // Increase timeout to 60s since API calls can be slow

  test('extracted script should be valid and executable', async () => {
    // Check if the script file exists
    const scriptExists = await fs.access(outputScriptPath)
      .then(() => true)
      .catch(() => false)
    
    expect(scriptExists).toBe(true)
    
    // Create a simple test file to analyze
    const testFilePath = path.join(outputDir, 'test-file.js')
    await fs.writeFile(testFilePath, `function hello() { return 'world' }`)
    
    // Create a test .env file with ANTHROPIC_API_KEY
    // Note: This is just to prevent errors if the script tries to load dotenv
    const envPath = path.join(outputDir, '.env')
    await fs.writeFile(envPath, 'ANTHROPIC_API_KEY=dummy-key\n')
    
    try {
      // Just check if the script can be executed without syntax errors
      // We'll use Node's --check flag which only validates syntax without running
      const nodeProcess = spawn('node', ['--check', outputScriptPath], {
        cwd: outputDir,
        env: process.env
      })
      
      let stderr = ''
      nodeProcess.stderr.on('data', (data) => {
        stderr += data.toString()
      })
      
      await new Promise((resolve, reject) => {
        nodeProcess.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`Process exited with code ${code}: ${stderr}`))
          }
        })
      })
      
      // If we get here, the script is syntactically valid
      expect(stderr).toBe('')
    } catch (err) {
      // If there's a syntax error, the test should fail
      console.error('Script execution failed:', err.message)
      throw err
    }
  })

  test('script should be able to modify a "hello world" file to "hello AI"', async () => {
    // Create a simple JavaScript file with "hello world"
    const helloWorldFilePath = path.join(outputDir, 'hello-world.js')
    await fs.writeFile(helloWorldFilePath, `console.log('hello world')`)

    // Create a test .env file with the real ANTHROPIC_API_KEY
    const envPath = path.join(outputDir, '.env')
    await fs.writeFile(envPath, `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_SK}\n`)

    console.log(`${outputDir}:${nodeModulesPath}:${process.env.NODE_PATH || ''}`,)

    try {
      // Run the script with our hello-world.js file as input
      // Properly simulate user input via stdin
      const scriptProcess = spawn('node', [
        '--require=dotenv/config', // Preload dotenv to ensure environment variables are loaded
        '--experimental-modules', // Ensure ES modules work properly
        // Set the Node.js module path to include both the output directory and the project's node_modules
        `--experimental-specifier-resolution=node`, // Allow importing without file extensions
        outputScriptPath, 
        helloWorldFilePath
      ], {
        cwd: outputDir,
        // Ensure the ANTHROPIC_API_KEY environment variable is passed to the child process
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_SK,
          // Set NODE_PATH to include both the output directory and the project's node_modules
          NODE_PATH: `${outputDir}:${nodeModulesPath}:${process.env.NODE_PATH || ''}`
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      let questionAsked = false
      let confirmationResponded = false
      let changesVerified = false

      scriptProcess.stdout.on('data', (data) => {
        const output = data.toString()
        stdout += output
        console.log('Script output:', output)
        
        // When prompted for a question, send our input
        // Using a wider pattern to detect question prompts
        if (!questionAsked && (
          output.toLowerCase().includes('question') || 
          output.toLowerCase().includes('query') || 
          output.toLowerCase().includes('ask') ||
          output.endsWith('?') ||
          output.endsWith('? ')
        )) {
          console.log('Detected question prompt, sending query...')
          questionAsked = true
          scriptProcess.stdin.write('Change "hello world" to "hello AI"\n')
        }
        
        // Look for common confirmation patterns: (y/n), yes/no, confirm, proceed, apply, etc.
        const confirmationPatterns = [
          /\(y\/n\)/i,
          /y\/n/i,
          /yes\/no/i,
          /confirm/i,
          /proceed/i,
          /apply.*changes/i,
          /save/i,
          /update/i,
          /modify/i,
        ]
        
        // Check if we've already seen a question and the output contains a confirmation pattern
        if (questionAsked && !confirmationResponded && (
          confirmationPatterns.some(pattern => pattern.test(output)) || 
          output.endsWith('?') || 
          output.endsWith('? ')
        )) {
          console.log('Detected confirmation prompt, sending "y"...')
          confirmationResponded = true
          scriptProcess.stdin.write('y\n')
          
          // Send another "y" after a short delay as some scripts might need multiple confirmations
          setTimeout(() => {
            scriptProcess.stdin.write('y\n')
          }, 500)
          
          // Add a timeout to verify file changes and then terminate the process
          // This ensures we don't leave the process running indefinitely if it's a loop
          setTimeout(async () => {
            try {
              if (!changesVerified) {
                changesVerified = true
                
                // Read the modified file to check if changes were applied
                const modifiedContent = await fs.readFile(helloWorldFilePath, 'utf-8')
                
                // Verify the file was changed from "hello world" to "hello AI"
                if (modifiedContent.includes('hello AI') && !modifiedContent.includes('hello world')) {
                  console.log('File changes verified successfully, terminating script process')
                  
                  // Terminate the process after verification
                  scriptProcess.kill('SIGTERM')
                }
              }
            } catch (err) {
              console.error('Error verifying file changes:', err)
              scriptProcess.kill('SIGTERM')
            }
          }, 3000) // Give the process 3 seconds to complete the file changes
        }
      })

      scriptProcess.stderr.on('data', (data) => {
        stderr += data.toString()
        console.error('Script error:', data.toString())
      })

      await new Promise((resolve, reject) => {
        scriptProcess.on('close', (code) => {
          console.log(`Script process exited with code ${code}`)
          resolve()
        })
        
        // Set a timeout to prevent the test from hanging
        setTimeout(() => {
          console.log('Test timeout reached, killing script process')
          scriptProcess.kill('SIGTERM')
          resolve() // Use resolve instead of reject to allow verification to continue
        }, 50000)
      })
      
      // Read the modified file to check if changes were applied
      const modifiedContent = await fs.readFile(helloWorldFilePath, 'utf-8')
      
      // Verify the file was changed from "hello world" to "hello AI"
      expect(modifiedContent).toContain('hello AI')
      expect(modifiedContent).not.toContain('hello world')
      
      // Check if original file was backed up with .orig extension
      const origFilePath = `${helloWorldFilePath}.orig`
      const origExists = await fs.access(origFilePath)
        .then(() => true)
        .catch(() => false)
      
      expect(origExists).toBe(true)
      
      if (origExists) {
        const origContent = await fs.readFile(origFilePath, 'utf-8')
        expect(origContent).toContain('hello world')
      }
      
    } catch (err) {
      console.error('Script execution failed:', err.message)
      throw err
    }
  }, 60000) // Set timeout to 60s to allow for real LLM call
})
