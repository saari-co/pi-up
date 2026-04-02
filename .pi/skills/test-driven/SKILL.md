---
name: test-driven
description: Test-driven development workflow implementing the red-green-refactor cycle. Guides writing failing tests first, implementing the minimum code to pass, then refactoring. Use when writing tests or implementing features with TDD.
---

# Test-Driven Development

## TDD Cycle: Red → Green → Refactor

### Step 1: RED — Write a Failing Test

1. Understand the requirement
2. Write the simplest test that captures the requirement
3. Run the test — confirm it FAILS
4. If it passes, you're either testing the wrong thing or the feature already exists

```bash
# Run only the new test
npm test -- --testPathPattern="<test-file>" --testNamePattern="<test-name>"
```

### Step 2: GREEN — Make It Pass

1. Write the MINIMUM code to make the test pass
2. Don't add features, error handling, or edge cases yet
3. It's OK if the code is ugly — we'll refactor next
4. Run the test — confirm it PASSES

```bash
npm test -- --testPathPattern="<test-file>"
```

### Step 3: REFACTOR — Clean Up

1. Now improve the code without changing behavior
2. Run ALL tests after each change
3. Apply project coding standards
4. Remove duplication

```bash
npm test
```

### Repeat

Continue the cycle for each new requirement or edge case.

## Test Structure

Follow the Arrange-Act-Assert pattern:

```typescript
describe("ComponentName", () => {
  describe("methodName", () => {
    it("should <expected behavior> when <condition>", () => {
      // Arrange — set up test data
      const input = createTestInput();

      // Act — call the code under test
      const result = methodName(input);

      // Assert — verify the result
      expect(result).toBe(expectedValue);
    });
  });
});
```

## Test Categories

Write tests in this priority order:

1. **Happy path**: Normal expected behavior
2. **Edge cases**: Boundary values, empty inputs, null/undefined
3. **Error cases**: Invalid inputs, network failures, timeouts
4. **Integration**: Components working together (sparingly)

## Guidelines

- **One assertion per test** (or closely related assertions)
- **Test behavior, not implementation**: Don't test private methods
- **Descriptive names**: Test name should describe the scenario
- **No test interdependence**: Each test must work in isolation
- **No mocking what you don't own**: Mock your own interfaces, not third-party libs
- **Fast tests**: Unit tests should complete in <1s total

## Verification

Before declaring tests complete:

```bash
# Run all tests
npm test

# Check coverage (if available)
npm test -- --coverage

# Verify no skipped tests
grep -r "it.skip\|xit\|xdescribe\|test.skip" test/ src/
```

Report actual test output — never claim "all tests pass" without running them.
