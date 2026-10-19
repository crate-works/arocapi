# Glossary

## What is protected

An entity's data comes in three levels, each with its own guard.

**Record**: The summary of an entity returned in listings, search results and
direct entity requests: its name, description, type, membership and licences.
Guarded only by visibility: a request sees the whole Record or nothing.
_Avoid_: summary, entity metadata.

**Metadata**: An entity's full RO-Crate metadata document. Guarded by access,
under the entity's metadata licence. _Avoid_: crate, record.

**Content**: The bytes of a file. Only file entities have Content. Guarded by
access, under the file entity's content licence. _Avoid_: data, media.

## How it is protected

**Visible**: An entity that exists for a given request. Only visible entities
appear in listings, search results, totals and facets, or can be fetched
directly. Decided by the consumer's visibility filters.

**Hidden**: An entity that isn't visible to a given request. Direct requests
for it get a 404, like a missing entity, unless the consumer prompts anonymous
requests to log in, which get a 401. _Avoid_: private, restricted (these
describe why something might be hidden, not the behaviour).

**Anonymous**: A request without valid credentials. Refusing an anonymous
request is a 401, so the client can prompt a login; refusing any other is a
403. In a repository without logins, no request is anonymous.

**Accessible**: Whether a request may read a visible entity's Metadata, and
its Content if it is a file. Decided by the consumer, who can also supply an
authorisation URL for requesting access. An entity can be visible but not
accessible.

**Denied**: The result of a request for Metadata or Content that isn't
accessible to it. It gets a 401 if the request is anonymous and a 403
otherwise, never 404, because the entity is visible. _Avoid_: restricted,
hidden.

## How it is found

**Search document**: The values the consumer supplies for one entity so search
can find it. Search never takes values from the Record or Metadata itself.
_Avoid_: index document, search record.

**Search field**: A named, typed value in a search document, declared with the
jobs it does: basic search, advanced queries, filtering, faceting or sorting. A
search field with no job is never published and only helps decide visibility.
_Avoid_: index field, property.
