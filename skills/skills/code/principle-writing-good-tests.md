---
name: writing-good-tests
description: Use when we need to write tests for a given feature implementation. Goes over best practices in writing maintainable and non-pedantic tests.
---

## When to write tests in the first place

Not every single line of code needs a test. Write tests selectively. The main goal should be to write impactful tests that verify public behavior and catch regressions. Do not maximize test coverage or add tests merely because a behavior is technically testable.

Some meaningful categories for testing include:

- Core business logic or user-visible behavior.
- Security, permissions, data integrity, or destructive operations.
- A bug being fixed, especially if it could plausibly recur. This is a tricky one, I don't want to write regression tests for every bug I find while I am testing and fixing code locally. Focus on the "plausibly recurring" bugs that might need regression tests. Regression tests might be good in places in the codebase where there are a lot of cross-cutting concerns that risk a bug being reintroduced.
- Complex logic whose correctness is not obvious from inspection.
- Public contracts between modules, services, APIs, or persisted data. This one is tricky as well as I don't want to test every single implementation detail here and we need to find the right level at which tests should be written so that tests stay meaninful.

Avoid writing these types of tests:

- Testing trivial getters, setters, constructors, wrappers, or pass-through functions.
- Adding a separate test for every branch when representative tests provide sufficient confidence.
- Testing constants, static configuration, type-system guarantees, or obvious language behavior.
- Snapshot tests that do not protect a meaningful interface.
- Tests for unlikely edge cases with negligible impact
- Duplicating coverage already provided by a higher-level test.
- Creating large test fixtures or extensive mocks for low-risk behavior.

Prefer the smallest test set that gives us strong confidence.

Before adding a test, ask:

What realistic regression does this catch?
Would that regression matter to users or system correctness?
Is this behavior already covered elsewhere?
Is the maintenance cost justified?
Can one higher-value test replace several narrow tests?

Do not add tests solely to increase coverage numbers.

For each PR, keep the test diff proportional to the implementation diff. If a change does not require new tests, say so rather than inventing tests.

When planning changes, briefly state which tests you intend to add and why. If the justification is weak, do not add the test.

When writing tests is justified, follow the guidelines below.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists — and survives refactors because it doesn't care about internal structure.

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

```typescript
// GOOD: Tests observable behavior
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```typescript
// BAD: Tests implementation details
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting on call counts/order
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means instead of interface

```typescript
// BAD: Bypasses interface to verify
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

**Tautological tests**: Expected value restates the implementation, so the test passes by construction.

```typescript
// BAD: Expected value is recomputed the way the code computes it
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: Expected value is an independent, known literal
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

# When to Mock

Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Databases (sometimes - prefer test DB)
- Time/randomness
- File system (sometimes)

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock:

**1. Use dependency injection**

Pass external dependencies in rather than creating them internally:

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**2. Prefer SDK-style interfaces over generic fetchers**

Create specific functions for each external operation instead of one generic function with conditional logic:

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch("/orders", { method: "POST", body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

The SDK approach means:

- Each mock returns one specific shape
- No conditional logic in test setup
- Easier to see which endpoints a test exercises
- Type safety per endpoint

## Seams — where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Tests should only live at seams.** While reviewing tests, look for any that reach into internals and move them to the appropriate seam. If you can't find a suitable seam, that is a code smell. Flag this to the user and suggest adding a new seam.

Ask: "What's the public interface, and which seams should we test?"

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological** — the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth — a known-good literal, a worked example, the spec.
