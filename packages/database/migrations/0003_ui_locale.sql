-- Add the preference without rebuilding settings or changing learning progress.
ALTER TABLE `settings` ADD COLUMN `ui_locale` text
  CONSTRAINT `settings_ui_locale` CHECK (`ui_locale` IS NULL OR `ui_locale` IN ('en', 'it'));
