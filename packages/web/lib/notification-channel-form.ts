import type { EmailChannelConfig, NotificationChannelSummary, NotificationChannelType } from '@/lib/db/notification-channels';

/* The Notifications settings form's model, kept apart from the component so the request it builds
 * and the state it starts from can be tested without rendering anything (the same split as
 * rule-form-payload.ts). Client-safe: type imports only. */

export interface EmailFormState {
  host: string;
  port: string;
  tls: EmailChannelConfig['tls'];
  username: string;
  fromAddress: string;
  toAddresses: string;
}

export const DEFAULT_EMAIL: EmailFormState = {
  host: '',
  port: '587',
  tls: 'starttls',
  username: '',
  fromAddress: '',
  toAddresses: '',
};

export interface FormState {
  name: string;
  type: NotificationChannelType;
  url: string;         // webhook URL or SMTP password
  email: EmailFormState;
  includeAdvisories: boolean;
}

export const DEFAULT_FORM: FormState = {
  name: '',
  type: 'teams',
  url: '',
  email: DEFAULT_EMAIL,
  includeAdvisories: false,
};

export function emailConfigFromForm(e: EmailFormState): EmailChannelConfig {
  return {
    host: e.host.trim(),
    port: parseInt(e.port, 10) || 587,
    tls: e.tls,
    username: e.username.trim(),
    fromAddress: e.fromAddress.trim(),
    toAddresses: e.toAddresses.trim(),
  };
}

/** The form's starting values when editing a saved channel. The secret is never sent to the
 *  browser, so `url` starts empty. */
export function formFromSummary(channel: NotificationChannelSummary): FormState {
  const cfg = channel.emailConfig;
  return {
    name: channel.name,
    type: channel.type,
    url: '',
    email: cfg ? {
      host: cfg.host,
      port: String(cfg.port),
      tls: cfg.tls,
      username: cfg.username,
      fromAddress: cfg.fromAddress,
      toAddresses: cfg.toAddresses,
    } : DEFAULT_EMAIL,
    includeAdvisories: channel.includeAdvisories,
  };
}

/** The body of the create (POST) and update (PUT) request. Every save sends the whole form. */
export function buildSaveBody(values: FormState, id?: string) {
  const base = {
    ...(id ? { id } : {}),
    name: values.name,
    type: values.type,
    url: values.url,
    includeAdvisories: values.includeAdvisories,
  };
  if (values.type === 'email') {
    return { ...base, config: emailConfigFromForm(values.email) };
  }
  return base;
}
