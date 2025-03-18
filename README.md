import modhel from 'modhel'

const result = await modhel('claude-3-7-sonnet').completion('Tell me a joke')
console.log(result)

This draft package, `modhel`, will provide a streamlined, high-level abstraction for interacting with various Large Language Models (LLMs).
It's deliberately designed as a JavaScript-centric library, focusing solely on simplifying LLM integration within JavaScript applications.
The library is opinionated and favors convention, making it extremely easy to use specific models in node or browser.
It eliminates the need to manage multiple SDKs and configurations, offering a unified interface.
For now only the `completion` method for Anthropics is functional.
