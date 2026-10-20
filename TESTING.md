# Testing Guide

This document provides comprehensive guidance on testing practices, setup, and execution for the AROCAPI project.

## Table of Contents

- [Overview](#overview)
- [Test Types](#test-types)
- [Setup](#setup)
- [Running Tests](#running-tests)
- [Writing Tests](#writing-tests)
- [Coverage Requirements](#coverage-requirements)
- [Continuous Integration](#continuous-integration)
- [Troubleshooting](#troubleshooting)

## Overview

The AROCAPI project uses **Vitest** as the primary testing framework, providing:

- **Unit tests** for individual functions and modules
- **Integration tests** for API endpoints with real database connections
- **OpenAPI validation** to ensure API compliance
- **95% coverage requirement** to maintain code quality

## Test Types

### Unit Tests

Test individual components in isolation with mocked dependencies.

**Location**: `src/**/*.test.ts`
**Purpose**:

- Validate business logic
- Test error handling
- Verify edge cases
- Fast execution without external dependencies

**Example**:

```typescript
// src/utils/errors.test.ts
import { describe, it, expect } from 'vitest';
import { createNotFoundError } from './errors.js';

describe('createNotFoundError', () => {
  it('should create error with message and resource', () => {
    const error = createNotFoundError('Not found', 'resource-id');
    expect(error).toEqual({
      error: 'Not Found',
      message: 'Not found',
      resource: 'resource-id',
    });
  });
});
```

### Integration Tests

Test complete API workflows with a real Postgres database and real search backends. The whole suite runs once with
`OpenSearchBackend` and once with `PostgresBackend`, and the shared search contract
(`src/test/helpers/searchBackendContract.ts`) holds both to the same `/search` behaviour.

**Location**: `src/test/integration.test.ts`
**Purpose**:

- Test full request/response cycles
- Validate database interactions
- Test with real external services
- End-to-end API functionality

**Example**:

```typescript
// src/test/integration.test.ts
describe('GET /entities', () => {
  it('should return entities from database', async () => {
    const app = getTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/entities',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBeGreaterThan(0);
  });
});
```

## Setup

### Prerequisites

1. **Docker** (for test databases)
2. **Node.js LTS**
3. **pnpm** package manager

### Local Development Setup

1. **Install dependencies**:

   ```bash
   pnpm install
   ```

1. **Verify setup**:

   ```bash
   pnpm run test
   ```

## Running Tests

### Available Commands

```bash
# Run all tests once
pnpm run test

# Run tests in watch mode
pnpm run test:watch

# Run tests with UI interface
pnpm run test:ui

# Run tests with coverage report
pnpm run test:coverage
```

### Test Environment

Tests use separate services from development:

- **Database**: Postgres 18 on `localhost:5433` (catalog_test)
- **OpenSearch**: `localhost:9201`
- **Environment**: Configured via `.env.test`

### Running Specific Tests

```bash
# Run specific test file
pnpm run test src/routes/entity.test.ts

# Run tests matching pattern
pnpm run test --grep "entity"

# Run only unit tests (exclude integration)
pnpm run test --exclude "**/integration.test.ts"
```

## Writing Tests

### Test Structure Guidelines

1. **Descriptive test names**:

   ```typescript
   it('should return 404 when entity not found', async () => {
     // Test implementation
   });
   ```

2. **AAA Pattern**: Arrange, Act, Assert

   ```typescript
   it('should filter entities by memberOf', async () => {
     // Arrange
     await seedTestData();

     // Act
     const response = await app.inject({
       method: 'GET',
       url: '/entities?memberOf=http://example.com/collection/1',
     });

     // Assert
     expect(response.statusCode).toBe(200);
     expect(response.body.entities).toHaveLength(1);
   });
   ```

3. **Use snapshots for complex objects**:

   ```typescript
   expect(response.body).toMatchSnapshot();
   ```

### Mocking Guidelines

**Unit Tests**: Mock all external dependencies

```typescript
const mockPrisma = {
  entity: {
    findFirst: vi.fn(),
  },
};

fastify.decorate('prisma', mockPrisma);
```

**Integration Tests**: Use real services but clean data between tests

```typescript
beforeEach(async () => {
  await seedTestData();
});

afterEach(async () => {
  await cleanupTestData();
});
```

### Error Testing

Always test both success and error paths:

```typescript
describe('Entity Route', () => {
  it('should return entity when found', async () => {
    // Test success case
  });

  it('should return 404 when not found', async () => {
    // Test error case
  });

  it('should return 500 on database error', async () => {
    // Test system error
  });
});
```

## Coverage Requirements

### Minimum Thresholds

- **Lines**: 95%
- **Functions**: 95%
- **Branches**: 95%
- **Statements**: 95%

### Excluded from Coverage

- Generated code (`src/generated/**`)
- Build output (`dist/**`)
- Example code (`example/**`)
- Test files (`**/*.test.ts`)
- Configuration files (`*.config.ts`)
- Scripts (`src/scripts/**`)

### Viewing Coverage

```bash
# Generate coverage report
pnpm run test:coverage

# Open HTML report
open coverage/index.html
```

### Coverage Enforcement

The CI pipeline will **fail** if coverage drops below 95%. This ensures:

- New code is properly tested
- Existing test quality is maintained
- Technical debt is minimized

## Continuous Integration

### GitHub Actions Workflow

Tests run automatically on:

- **Pull requests** to main branch
- **Pushes** to main branch, as the gate in the Publish Package workflow (see `RELEASING.md`)
- **Manual triggers** via workflow_dispatch

### CI Pipeline Steps

1. **Setup**: Install dependencies, start services
2. **Health checks**: Verify database and OpenSearch connectivity
3. **Database setup**: Run migrations
4. **Linting**: Code style (biome), type checking and unused code (knip)
5. **Testing**: Execute full test suite
6. **Coverage**: Verify coverage thresholds
7. **Reporting**: Post results to PR

### Pipeline Requirements

- **All tests must pass**
- **Coverage must be ≥95%**
- **Linting must pass**
- **Type checking must pass**

### Test Services in CI

The pipeline uses **GitHub Actions services** to provide:

- Postgres 18 database (port 5433)
- OpenSearch 3 (port 9201)
- Health checks to ensure service readiness

### Debugging Tests

#### Enable Debug Output

```bash
# Run with debug logging
DEBUG=* pnpm run test

# Vitest UI for interactive debugging
pnpm run test:ui
```
