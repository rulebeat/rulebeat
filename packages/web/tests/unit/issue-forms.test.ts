/**
 * Architecture test: the GitHub issue forms ask for what a maintainer needs, warn that the repo is
 * public, and cannot drift from the product they describe.
 *
 * The repository, its history and its issues are public and permanent, so every form opens with a
 * warning to redact tenant ids, subscription ids and resource names. The Rule idea form's category
 * dropdown is checked against BUILTIN_CATEGORIES so a new built-in category forces the form to
 * follow. Files are read off disk and parsed, and the sweep asserts it found the forms so the test
 * cannot pass by finding nothing.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
// The core package's index does not export the constant, so read it from source.
import { BUILTIN_CATEGORIES } from '../../../core/src/types';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(WEB_ROOT, '..', '..');
const TEMPLATE_DIR = join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE');

interface FormElement {
  type: string;
  id?: string;
  attributes?: { value?: string; label?: string; options?: string[]; render?: string };
  validations?: { required?: boolean };
}
interface IssueForm {
  name: string;
  description: string;
  labels: string[];
  body: FormElement[];
}

function load(file: string): unknown {
  return parseYaml(readFileSync(join(TEMPLATE_DIR, file), 'utf8'));
}
function loadForm(file: string): IssueForm {
  return load(file) as IssueForm;
}
function inputs(form: IssueForm): FormElement[] {
  return form.body.filter((el) => el.type !== 'markdown');
}
function requiredIds(form: IssueForm): string[] {
  return inputs(form)
    .filter((el) => el.validations?.required === true)
    .map((el) => el.id!)
    .sort();
}
function optionalIds(form: IssueForm): string[] {
  return inputs(form)
    .filter((el) => el.validations?.required !== true)
    .map((el) => el.id!)
    .sort();
}

const FORMS: Array<{
  file: string;
  labels: string[];
  required: string[];
  optional: string[];
}> = [
  {
    file: 'bug_report.yml',
    labels: ['bug', 'needs-triage'],
    required: ['expected', 'happened', 'version'],
    optional: ['deployment', 'logs', 'steps'],
  },
  {
    file: 'feature_request.yml',
    labels: ['enhancement', 'needs-triage'],
    required: ['desired', 'problem'],
    optional: [],
  },
  {
    file: 'rule_idea.yml',
    labels: ['enhancement', 'needs-triage'],
    required: ['flags', 'why'],
    optional: ['category', 'query', 'recommendation', 'resource-type', 'severity'],
  },
];

const ALLOWED_LABELS = ['bug', 'enhancement', 'needs-triage'];

describe('issue template directory', () => {
  it('holds exactly the three forms and the config', () => {
    expect(readdirSync(TEMPLATE_DIR).sort()).toEqual([
      'bug_report.yml',
      'config.yml',
      'feature_request.yml',
      'rule_idea.yml',
    ]);
  });
});

describe.each(FORMS)('issue form $file', ({ file, labels, required, optional }) => {
  const form = loadForm(file);

  it('has a name, a description and a non-empty body', () => {
    expect(form.name.trim()).not.toBe('');
    expect(form.description.trim()).not.toBe('');
    expect(form.body.length).toBeGreaterThan(0);
  });

  it('carries exactly the expected labels, all of which already exist', () => {
    expect([...form.labels].sort()).toEqual([...labels].sort());
    for (const label of form.labels) expect(ALLOWED_LABELS).toContain(label);
  });

  it('gives every input a unique id', () => {
    const ids = inputs(form).map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(typeof id === 'string' && id.length > 0).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires exactly the expected fields and leaves the rest optional', () => {
    expect(requiredIds(form)).toEqual(required);
    expect(optionalIds(form)).toEqual(optional);
  });

  it('opens with a markdown warning that the repo is public and what to redact', () => {
    const first = form.body[0];
    expect(first.type).toBe('markdown');
    const text = first.attributes?.value ?? '';
    expect(text).toMatch(/public/i);
    expect(text).toMatch(/tenant ids/i);
    expect(text).toMatch(/subscription ids/i);
    expect(text).toMatch(/resource names/i);
    expect(text).toMatch(/identifies an environment/i);
  });
});

describe('bug report form', () => {
  const form = loadForm('bug_report.yml');
  const byId = (id: string) => form.body.find((el) => el.id === id);

  it('says where to find the version', () => {
    const description = (byId('version')?.attributes as { description?: string }).description ?? '';
    expect(description).toMatch(/Diagnostics/);
    expect(description).toMatch(/System/);
  });

  it('renders logs as a shell block', () => {
    expect(byId('logs')?.attributes?.render).toBe('shell');
  });
});

describe('rule idea form', () => {
  const form = loadForm('rule_idea.yml');
  const byId = (id: string) => form.body.find((el) => el.id === id);

  it('offers exactly the built-in categories', () => {
    expect(byId('category')?.attributes?.options).toEqual([...BUILTIN_CATEGORIES]);
  });

  it('offers exactly the severities', () => {
    expect(byId('severity')?.attributes?.options).toEqual(['critical', 'high', 'medium', 'low', 'info']);
  });

  it('renders the query as KQL', () => {
    expect(byId('query')?.attributes?.render).toBe('kql');
  });
});

describe('issue template config', () => {
  const config = load('config.yml') as {
    blank_issues_enabled: boolean;
    contact_links: Array<{ name: string; url: string; about: string }>;
  };

  it('turns blank issues off', () => {
    expect(config.blank_issues_enabled).toBe(false);
  });

  it('links the private advisory page, Discussions and the docs', () => {
    expect(config.contact_links.map((l) => l.url)).toEqual([
      'https://github.com/rulebeat/rulebeat/security/advisories/new',
      'https://github.com/rulebeat/rulebeat/discussions',
      'https://docs.rulebeat.com',
    ]);
    for (const link of config.contact_links) {
      expect(link.name.trim()).not.toBe('');
      expect(link.about.trim()).not.toBe('');
    }
  });
});

describe('copy', () => {
  const files = ['bug_report.yml', 'config.yml', 'feature_request.yml', 'rule_idea.yml'].map((f) =>
    join(TEMPLATE_DIR, f),
  );
  const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');

  it('has no em dash in the forms or in CONTRIBUTING.md', () => {
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain('\u2014');
    expect(contributing).not.toContain('\u2014');
  });

  it('CONTRIBUTING.md has the rule proposal section and links both forms', () => {
    expect(contributing).toContain('## Proposing a rule');
    expect(contributing).toContain('https://github.com/rulebeat/rulebeat/issues/new?template=rule_idea.yml');
    expect(contributing).toContain('https://github.com/rulebeat/rulebeat/issues/new?template=bug_report.yml');
  });
});
