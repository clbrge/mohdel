const models = {
  "anthropic/claude-3-5-sonnet-20240620": {
    "id": "claude-3-5-sonnet-20240620",
    "displayName": "claude-3-5-sonnet-20240620",
    "description": "",
    "inputTokenLimit": 0,
    "outputTokenLimit": 0,
    "type": "model",
    "display_name": "Claude 3.5 Sonnet (Old)",
    "created_at": "2024-06-20T00:00:00Z"
  },
  "anthropic/claude-3-opus-20240229": {
    "id": "claude-3-opus-20240229",
    "displayName": "claude-3-opus-20240229",
    "description": "",
    "inputTokenLimit": 0,
    "outputTokenLimit": 0,
    "type": "model",
    "display_name": "Claude 3 Opus",
    "created_at": "2024-02-29T00:00:00Z"
  },
  "anthropic/claude-3-sonnet-20240229": {
    "id": "claude-3-sonnet-20240229",
    "displayName": "claude-3-sonnet-20240229",
    "description": "",
    "inputTokenLimit": 0,
    "outputTokenLimit": 0,
    "type": "model",
    "display_name": "Claude 3 Sonnet",
    "created_at": "2024-02-29T00:00:00Z"
  },
  "anthropic/claude-3-haiku-20240307": {
    "id": "claude-3-haiku-20240307",
    "displayName": "claude-3-haiku-20240307",
    "description": "",
    "inputTokenLimit": 0,
    "outputTokenLimit": 0,
    "type": "model",
    "display_name": "Claude 3 Haiku",
    "created_at": "2024-03-07T00:00:00Z"
  },
  "openai/gpt-4o": {
    "id": "gpt-4o",
    "displayName": "gpt-4o",
    "description": "",
    "inputTokenLimit": 0,
    "outputTokenLimit": 0,
    "object": "model",
    "created": 1715367049,
    "owned_by": "system"
  },
  "openai/gpt-4-turbo": {
    "id": "gpt-4-turbo",
    "displayName": "gpt-4-turbo",
    "description": "",
    "inputTokenLimit": 0,
    "outputTokenLimit": 0,
    "object": "model",
    "created": 1712361441,
    "owned_by": "system"
  },
  "openai/gpt-4": {
    "id": "gpt-4",
    "displayName": "gpt-4",
    "description": "",
    "inputTokenLimit": 0,
    "outputTokenLimit": 0,
    "object": "model",
    "created": 1687882411,
    "owned_by": "openai"
  },
  "openai/gpt-3.5-turbo": {
    "id": "gpt-3.5-turbo",
    "displayName": "gpt-3.5-turbo",
    "description": "",
    "inputTokenLimit": 0,
    "outputTokenLimit": 0,
    "object": "model",
    "created": 1677610602,
    "owned_by": "openai"
  },
  "gemini/gemini-1.5-pro": {
    "id": "gemini-1.5-pro",
    "displayName": "Gemini 1.5 Pro",
    "description": "Stable version of Gemini 1.5 Pro, our mid-size multimodal model that supports up to 2 million tokens, released in May of 2024.",
    "inputTokenLimit": 2000000,
    "outputTokenLimit": 8192,
    "supportedActions": [
      "generateContent",
      "countTokens"
    ],
    "version": "001",
    "tunedModelInfo": {}
  },
  "gemini/gemini-1.5-flash": {
    "id": "gemini-1.5-flash",
    "displayName": "Gemini 1.5 Flash",
    "description": "Alias that points to the most recent stable version of Gemini 1.5 Flash, our fast and versatile multimodal model for scaling across diverse tasks.",
    "inputTokenLimit": 1000000,
    "outputTokenLimit": 8192,
    "supportedActions": [
      "generateContent",
      "countTokens"
    ],
    "version": "001",
    "tunedModelInfo": {}
  }
}

export default models
