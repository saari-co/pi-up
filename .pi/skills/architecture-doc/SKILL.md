---
name: architecture-doc
description: Generate architecture documentation from code analysis. Creates structured docs covering system design, component relationships, data flow, and deployment architecture. Use when documenting a project or onboarding new developers.
---

# Architecture Documentation

## Workflow

### Phase 1: Discover

Use project-analysis skill first if unfamiliar with the codebase, then deep-dive:

```bash
# Entry points and exports
grep -rn "export default\|module.exports\|export function\|export class" src/ --include="*.ts" --include="*.js" | head -50

# Route definitions
grep -rn "app\.\(get\|post\|put\|delete\|patch\|use\)\|router\.\|@Get\|@Post\|@Controller" src/ --include="*.ts" | head -30

# Database models
grep -rn "Schema\|@Entity\|@Table\|model\s\+\w\+\s*{" src/ --include="*.ts" --include="*.prisma" | head -20

# Environment dependencies
grep -rn "process\.env\.\|env\." src/ --include="*.ts" | sed 's/.*process\.env\.\([A-Z_]*\).*/\1/' | sort -u
```

### Phase 2: Map Components

For each major component/module:
1. Read the main file
2. Trace its imports (dependencies)
3. Trace its exports (dependents)
4. Identify its responsibility

### Phase 3: Generate Document

```markdown
# Architecture: <Project Name>

## System Overview

<2-3 paragraph description of what the system does, who it's for, 
and how it's organized at the highest level>

## Component Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client     │────▶│   API       │────▶│  Database   │
│   (React)    │◀────│   (Express) │◀────│  (Postgres) │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────▼──────┐
                    │  Services   │
                    │  (Business  │
                    │   Logic)    │
                    └─────────────┘
```

## Components

### <Component Name>
- **Location**: `src/<path>/`
- **Responsibility**: <what it does>
- **Key files**:
  - `<file>`: <purpose>
- **Dependencies**: <what it depends on>
- **Dependents**: <what depends on it>
- **Public API**:
  ```typescript
  <key exported functions/classes>
  ```

## Data Flow

### <Flow Name> (e.g., "User Authentication")
```
1. Client sends POST /api/auth/login
2. AuthController validates input
3. AuthService checks credentials
4. JWT token generated and returned
5. Client stores token, sends in headers
```

## Database Schema

### Key Tables/Collections
| Table | Purpose | Key Fields |
|-------|---------|------------|
| users | User accounts | id, email, role |

## Configuration

### Environment Variables
| Variable | Required | Purpose |
|----------|----------|---------|
| DATABASE_URL | Yes | Database connection |
| JWT_SECRET | Yes | Token signing |

## Deployment

### Infrastructure
- **Runtime**: <Node.js 22, Python 3.12, etc.>
- **Database**: <PostgreSQL 16, MongoDB 7, etc.>
- **CI/CD**: <GitHub Actions, etc.>

### Build & Run
```bash
npm install          # Install dependencies
npm run build        # Build for production
npm start            # Start server
npm test             # Run tests
```

## Key Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| <choice> | <why> | <what else was considered> |
```

## Guidelines

- Use ASCII diagrams over external tools (they live in the repo)
- Document DECISIONS and WHY, not just WHAT
- Keep it DRY — link to code instead of duplicating it
- Write for a new developer joining the team
- Update the doc as part of architectural changes
