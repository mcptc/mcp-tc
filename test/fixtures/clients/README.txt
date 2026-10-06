Sample MCP client config files for test/scan.test.js and test/clients.test.js. Every key and token in them is made
up (they start with FAKE or test) and must never appear in anything mcp-tc prints or sends.
The scan tests copy them into a temporary home folder: {{CWD}} in claude.json becomes the test's working folder.
