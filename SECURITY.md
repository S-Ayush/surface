# Security policy

## Supported version

Only the latest release gets security fixes. Until the first release, only the `main` branch does.

## Reporting a vulnerability

Please report it privately. Do not open a public issue, pull request or discussion.

Use your code host's private vulnerability reporting for this repository (on GitHub: the
**Security** tab, then **Report a vulnerability**). If the host does not offer it, open a public
issue that says only that you have a security report and asks the maintainers for a private
channel. Put no details in it.

Include:

- what the problem is and which part of Surface it affects (server, web app, sync, MCP, Docker image);
- the version or commit you tested;
- steps to reproduce, or a proof of concept;
- the impact as you see it, for example "a member can read an issue in a private team";
- whether you want to be credited.

Do not include real secrets, or other people's data.

## What to expect

The maintainers will acknowledge your report, confirm or dispute it, and keep you informed until a
fix is released. Please give us reasonable time to fix the problem before you disclose it.

## Scope

In scope: the Surface server, web app, sync protocol, MCP server, the Docker image and the compose
files in this repo. Out of scope: problems that need a malicious administrator of the install, and
weaknesses in your own host, proxy or PostgreSQL setup.
