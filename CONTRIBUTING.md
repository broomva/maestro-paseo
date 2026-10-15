# Contributing to Maestro for Paseo

Thank you for your interest in contributing to Maestro!

Maestro is a Paseo plugin: work is folders (`_work.md`), sessions are dispatches, and the human's one verb is the gate.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Bun](https://bun.sh/) >= 1.2
- [Paseo](https://github.com/broomva/paseo) >= 0.11

### Local Setup

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/broomva/maestro-paseo.git
   cd maestro-paseo
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run local checks:
   ```bash
   npm run check
   ```
   This runs:
   - TypeScript typechecking (`tsc --noEmit`)
   - Biome linter & formatter (`biome check .`)
   - Test suite (`bun test --timeout 30000`)

4. Load into Paseo for live testing:
   - Open Paseo **Settings -> Plugins** and add the repository directory as a plugin source, or:
   ```bash
   paseo plugin install /path/to/maestro-paseo
   paseo plugin reload maestro
   ```

## Development Workflow

- **Branching**: Create a branch off `main` with a descriptive name (`feat/<slug>`, `fix/<slug>`, `chore/<slug>`).
- **Commit Messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- **Testing**: Add unit tests for new features and bug fixes.
- **Pull Requests**:
  - Keep PRs focused on a single change.
  - Ensure all checks (`npm run check`) pass locally before opening a PR.
  - Fill out the PR template with clear context and test results.

## Security

Please report security vulnerabilities responsibly by following our [Security Policy](SECURITY.md). Do not open public issues for security vulnerabilities.
