-- Status-page custom logo: optional external HTTPS logo URL per public page.
-- The Worker never fetches this URL; it is rendered by visitors' browsers.
-- Keep this file append-only. Future schema changes must be new migrations.

ALTER TABLE status_pages ADD COLUMN logo_url TEXT;
