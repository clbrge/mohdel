import { startVitest } from 'vitest/node'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Configuration for the test runs
const runTests = async (numRuns = 2) => {
  console.log(`Starting ${numRuns} test runs of demo.test.js`)
  
  const results = {
    runs: numRuns,
    passed: 0,
    failed: 0,
    totalDuration: 0,
    startTime: Date.now(),
    testResults: []
  }

  for (let i = 0; i < numRuns; i++) {
    console.log(`\n--- Run ${i + 1}/${numRuns} ---`)
    
    const runStart = Date.now()
    
    try {
      // Create a unique test output directory for each run
      const testOutputDir = path.join(__dirname, '..', 'test-output', `run-${i + 1}`)
      await fs.mkdir(testOutputDir, { recursive: true })
      
      // Get project root for proper module resolution
      const projectRoot = path.resolve(__dirname, '..')
      
      // Pass the node_modules path to the test environment
      const nodeModulesPath = path.join(projectRoot, 'node_modules')

      // Start Vitest programmatically with the correct environment setup
      const vitest = await startVitest('test', [], {
        run: true,
        reporters: ['verbose'],
        testNamePattern: 'mohdel demo',
        environment: 'node',
        environmentOptions: {
          TEST_OUTPUT_DIR: testOutputDir,
          NODE_PATH: nodeModulesPath
        },
        root: projectRoot, // Set the root directory for proper module resolution
        resolve: {
          // Ensure we're using the dependencies from the project's node_modules
          conditions: ['node', 'import', 'default'],
          extensions: ['.js', '.json', '.node'],
          preserveSymlinks: false
        },
        // Pass environment variables to the test runner
        env: {
          ...process.env,
          TEST_OUTPUT_DIR: testOutputDir,
          NODE_PATH: nodeModulesPath
        }
      })
      
      // Wait for tests to complete
      await new Promise(resolve => {
        const onFinished = () => {
          resolve()
          cleanup()
        }
        
        const cleanup = () => {
          if (vitest.server && vitest.server.off) {
            vitest.server.off('onFinished', onFinished)
          }
        }
        
        if (vitest.server && vitest.server.on) {
          vitest.server.on('onFinished', onFinished)
        } else {
          setTimeout(resolve, 30000) // 30 second timeout
        }
      })
      
      // Get test results if available
      const testSummary = {
        errors: [],
        failedTests: 0,
        passedTests: 0,
        totalTests: 0
      }
      
      // Extract test results from Vitest state
      if (vitest.state && vitest.state.getFiles) {
        const files = vitest.state.getFiles()
        for (const file of files) {
          for (const test of file.tests || []) {
            testSummary.totalTests++
            if (test.result && test.result.state === 'fail') {
              testSummary.failedTests++
              testSummary.errors.push({
                name: test.name,
                error: test.result.error ? 
                  (test.result.error.message || 'Unknown error') : 
                  'Unknown error'
              })
            } else if (test.result && test.result.state === 'pass') {
              testSummary.passedTests++
            }
          }
        }
      }
      
      // Check if we have failed tests in this run
      const runDuration = Date.now() - runStart
      const runPassed = testSummary.failedTests === 0 && testSummary.totalTests > 0
      
      // Store results for this run
      results.testResults.push({
        run: i + 1,
        passed: runPassed,
        duration: runDuration,
        totalTests: testSummary.totalTests,
        passedTests: testSummary.passedTests,
        failedTests: testSummary.failedTests,
        errors: testSummary.errors.length > 0 ? testSummary.errors : null
      })
      
      if (runPassed) {
        results.passed++
        console.log(`Run ${i + 1} PASSED: ${testSummary.passedTests}/${testSummary.totalTests} tests passed`)
      } else {
        results.failed++
        console.log(`Run ${i + 1} FAILED: ${testSummary.failedTests}/${testSummary.totalTests} tests failed`)
        if (testSummary.errors.length > 0) {
          console.log('Errors:')
          testSummary.errors.forEach((error, idx) => {
            console.log(`  ${idx + 1}. [${error.name}]: ${error.error}`)
          })
        }
      }
      
      results.totalDuration += runDuration
      
      // Properly close Vitest
      await vitest.close()
    } catch (err) {
      console.error(`Error in test run ${i + 1}:`, err)
      results.failed++
      results.testResults.push({
        run: i + 1,
        passed: false,
        duration: Date.now() - runStart,
        error: err.message
      })
    }
  }
  
  results.endTime = Date.now()
  results.totalDurationSeconds = (results.endTime - results.startTime) / 1000
  results.avgRunDuration = results.totalDuration / numRuns
  results.passRate = (results.passed / numRuns) * 100
  
  // Print summary
  console.log('\n=== TEST RUNS SUMMARY ===')
  console.log(`Total runs: ${results.runs}`)
  console.log(`Passed: ${results.passed} (${results.passRate.toFixed(2)}%)`)
  console.log(`Failed: ${results.failed}`)
  console.log(`Total duration: ${results.totalDurationSeconds.toFixed(2)}s`)
  console.log(`Average run duration: ${(results.avgRunDuration / 1000).toFixed(2)}s`)
  
  // Save results to file
  const resultsPath = path.join(__dirname, '..', 'test-results.json')
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2))
  console.log(`\nDetailed results saved to: ${resultsPath}`)
  
  return results
}

// If called directly from command line
if (import.meta.url === `file://${process.argv[1]}`) {
  const numRuns = parseInt(process.argv[2], 10) || 2
  runTests(numRuns)
    .then(() => {
      console.log('Test runner completed')
    })
    .catch(err => {
      console.error('Test runner failed:', err)
      process.exit(1)
    })
}

export default runTests
