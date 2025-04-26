const providers = {
  anthropic: {
    sdk: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    // Anthropic Error codes :
    // 400 - invalid_request_error: There was an issue with the format or content of your request. We may also use this error type for other 4XX status codes not listed below.
    // 401 - authentication_error: There’s an issue with your API key.
    // 403 - permission_error: Your API key does not have permission to use the specified resource.
    // 404 - not_found_error: The requested resource was not found.
    // 429 - rate_limit_error: Your account has hit a rate limit.
    // 500 - api_error: An unexpected error has occurred internal to Anthropic’s systems.
    // 529 - overloaded_error: Anthropic’s API is temporarily overloaded.
    // Anthropic Error structure :
    // Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}
    interpretError: err => ({
      message: err.error?.error?.message,
      code: ['rate_limit_error', 'overloaded_error'].includes(err.error?.error?.type) ? 504 : 502
    })
  },
  deepseek: {
    sdk: 'openai',
    apiKeyEnv: 'DEEPSEEK_API_SK',
    createConfiguration: apiKey => ({ baseURL: 'https://api.deepseek.com', apiKey }),
    interpretError: err => ({
      message: err.error?.error?.message,
      code: [429, 500, 503].includes(err.status) ? 504 : 502
    })
  },
  gemini: {
    sdk: 'gemini',
    apiKeyEnv: 'GEMINI_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    // Google Error codes :
    // 400 INVALID_ARGUMENT The request body is malformed. Check the API reference for request format, examples, and supported versions. Using features from a newer API versio>
    // 403 PERMISSION_DENIED Your API key doesn't have the required permissions. Check that your API key is set and has the right access.
    // 404 NOT_FOUND The requested resource wasn't found. Check if all parameters in your request are valid for your API version.
    // 429 RESOURCE_EXHAUSTED You've exceeded the rate limit. Ensure you're within the model's rate limit. Request a quota increase if needed.
    // 500 INTERNAL An unexpected error occurred on Google's side. Wait a bit and retry your request. If the issue persists after retrying, please report it using the Send fee>
    // 503 UNAVAILABLE The service may be temporarily overloaded or down. Wait a bit and retry your request. If the issue persists after retrying, please report it using the S>
    // Anthropic Error structure :
    // {
    //   status: 400,
    //   statusText: 'Bad Request',
    //   errorDetails: [
    //     {
    //       '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    //       reason: 'API_KEY_INVALID',
    //       domain: 'googleapis.com',
    //       metadata: [Object]
    //     }
    //   ]
    // }
    interpretError: err => ({
      message: err.error?.error?.message,
      code: [429, 500, 503].includes(err.status) ? 504 : 502
    })
  },
  groq: {
    sdk: 'groq',
    apiKeyEnv: 'GROQ_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    interpretError: err => ({
      message: err.error?.error?.message,
      code: [429, 500, 503].includes(err.status) ? 504 : 502
    })
  },
  openai: {
    sdk: 'openai',
    apiKeyEnv: 'OPENAI_API_SK',
    createConfiguration: apiKey => ({ apiKey }),
    // OpenAI GPT Error codes :
    // 401 - Invalid AuthenticationCause: Invalid Authentication
    // Solution: Ensure the correct API key and requesting organization are being used.
    // 401 - Incorrect API key providedCause: The requesting API key is not correct.
    // Solution: Ensure the API key used is correct, clear your browser cache, or generate a new one.
    // 401 - You must be a member of an organization to use the APICause: Your account is not part of an organization.
    // Solution: Contact us to get added to a new organization or ask your organization manager to invite you to an organization.
    // 403 - Country, region, or territory not supportedCause: You are accessing the API from an unsupported country, region, or territory.
    // Solution: Please see this page for more information.
    // 429 - Rate limit reached for requestsCause: You are sending requests too quickly.
    // Solution: Pace your requests. Read the Rate limit guide.
    // 429 - You exceeded your current quota, please check your plan and billing detailsCause: You have run out of credits or hit your maximum monthly spend.
    // Solution: Buy more credits or learn how to increase your limits.
    // 500 - The server had an error while processing your request Cause: Issue on our servers.
    // Solution: Retry your request after a brief wait and contact us if the issue persists. Check the status page.
    // 503 - The engine is currently overloaded, please try again later Cause: Our servers are experiencing high traffic.
    // Solution: Please retry your requests after a brief wait.
    // status: 401,
    // OpenAI GPT Error structure :
    // request_id: 'req_87f6a90cdfdef8b54b64d6a4523fef88',
    // error: {
    //   message: 'Incorrect API key provided: sk-DI3Tm****************************************Mxxx. You can find your API key at https://platform.openai.com/account/api-keys.>
    //   type: 'invalid_request_error',
    //   param: null,
    //   code: 'invalid_api_key'
    // },
    // code: 'invalid_api_key',
    // param: null,
    // type: 'invalid_request_error'
    interpretError: err => ({
      message: err.error?.error?.message,
      code: [429, 500, 503].includes(err.status) ? 504 : 502
    })
  },
  xai: {
    sdk: 'openai',
    apiKeyEnv: 'XAI_API_SK',
    createConfiguration: apiKey => ({ baseURL: 'https://api.x.ai/v1', apiKey })
  }
}

Object.freeze(providers)

export default providers
