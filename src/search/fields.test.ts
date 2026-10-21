import { describe, expect, it } from 'vitest';
import { capabilitiesFromFields } from './fields.js';

describe('capabilitiesFromFields', () => {
  it('publishes each role under the field name, with text and keyword as string', () => {
    const capabilities = capabilitiesFromFields({
      name: { type: 'text', label: 'Title', advanced: true, sort: true },
      description: { type: 'text', advanced: true },
      inLanguage: { type: 'keyword', label: 'Language', facet: true },
      mediaType: { type: 'keyword', facet: { size: 100 } },
      originatedOn: { type: 'date', label: 'Date', filter: true, sort: true },
      pages: { type: 'number', filter: true },
      hasContent: { type: 'boolean', facet: true },
      location: { type: 'geo' },
    });

    expect(capabilities).toEqual({
      filters: {
        inLanguage: { type: 'string', label: 'Language' },
        mediaType: { type: 'string' },
        originatedOn: { type: 'date', label: 'Date' },
        pages: { type: 'number' },
        hasContent: { type: 'boolean' },
      },
      facets: {
        inLanguage: { label: 'Language' },
        mediaType: {},
        hasContent: {},
      },
      sorts: {
        name: { label: 'Title' },
        originatedOn: { label: 'Date' },
      },
      searchTypes: {
        basic: {},
        advanced: {
          fields: {
            name: { label: 'Title' },
            description: {},
          },
        },
      },
      geo: { supported: true },
    });
  });

  it('omits advanced search and geo when no field supports them', () => {
    expect(capabilitiesFromFields({ name: { type: 'text' } })).toEqual({
      filters: {},
      facets: {},
      sorts: {},
      searchTypes: { basic: {} },
      geo: { supported: false },
    });
  });

  it('never publishes a field with no role', () => {
    const capabilities = capabilitiesFromFields({
      name: { type: 'text', basic: false },
      draft: { type: 'boolean' },
      rootCollection: { type: 'keyword', filter: false, facet: false, sort: false, advanced: false },
    });

    expect(JSON.stringify(capabilities)).not.toMatch(/name|draft|rootCollection/);
  });

  it('publishes a text field filtered on as a string filter', () => {
    expect(capabilitiesFromFields({ name: { type: 'text', filter: true } }).filters).toEqual({
      name: { type: 'string' },
    });
  });
});
