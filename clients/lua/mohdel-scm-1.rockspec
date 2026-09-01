package = "mohdel"
version = "scm-1"
source = {
  url = "git+https://github.com/clbrge/mohdel.git",
  dir = "mohdel/clients/lua",
}
description = {
  summary = "Client for the mohdel thin-gate: one call for 13 providers or local inference",
  detailed = [[
Streams events from a mohdel thin-gate over its unix socket: chat
completions with tool calls and vision, image generation, speech to
text, and per-call USD cost. Pure Lua 5.1+; transports over LuaSocket
or curl.]],
  homepage = "https://github.com/clbrge/mohdel",
  license = "MIT",
}
dependencies = {
  "lua >= 5.1",
  "dkjson >= 2.5",
  "luasocket >= 3.0",
}
build = {
  type = "builtin",
  modules = {
    ["mohdel"] = "mohdel/init.lua",
    ["mohdel.protocol"] = "mohdel/protocol.lua",
    ["mohdel.transport.luasocket"] = "mohdel/transport/luasocket.lua",
    ["mohdel.transport.curl"] = "mohdel/transport/curl.lua",
  },
}
