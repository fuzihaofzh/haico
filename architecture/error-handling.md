# Error Handling

HAICO backend error handling should move toward a layered model:

- **Routes** describe the successful HTTP flow: read params/body/query, check access, call services, and return success responses.
- **Services** contain business logic. When business rules fail, services throw specific domain errors such as `KnowledgeEntryNotFoundError` or `InvalidKnowledgeCategoryError`.
- **Services do not return transport-shaped failures** such as `{ ok: false, statusCode, error }`.
- **Services do not wrap internal tools by default**. Database, filesystem, and third-party errors should bubble up unless the service can translate them into a clearer domain error.
- **Framework middleware** catches thrown errors and turns them into HTTP responses.

## Error Categories

There are two broad categories:

1. **Expected domain errors**

   These represent known business outcomes:

   - validation failures
   - missing entities
   - conflicts
   - authorization failures

   Domain errors should be explicit classes owned by their domain module. For example, knowledge-specific errors live near knowledge services, not in the Fastify middleware layer.

2. **Unexpected internal errors**

   These represent implementation failures or infrastructure problems:

   - database errors
   - filesystem errors
   - programming bugs
   - third-party library failures

   These should bubble up to the global error handler. The real error is logged, but production responses should not expose private details.

## HTTP Mapping

Domain errors are mapped to HTTP by framework-level code:

- invalid input -> `400`
- unauthenticated -> `401`
- forbidden -> `403`
- not found -> `404`
- conflict -> `409`
- unknown internal errors -> `500`

The mapping belongs outside services. Services should not need to know HTTP status codes.

## Development And Production Responses

The global error handler should always log the real error.

For API responses:

- expected domain errors return their public message in all environments
- unexpected errors return the real message outside production
- unexpected errors return `Internal server error` in production

## Migration Strategy

This should be done gradually:

1. Add a global Fastify error handler and a centralized error mapper.
2. For one service at a time, add domain-specific error classes.
3. Change the service to throw those domain errors instead of returning HTTP-shaped failure results.
4. Keep existing routes that already send `{ error }` responses working.
5. Later, add throwing access helpers such as `requireProjectAccess`.
6. Keep old `ensureProjectAccess` style helpers as compatibility wrappers until routes are migrated.

The long-term target is that new routes call services directly and let errors bubble to middleware.
