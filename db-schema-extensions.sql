-- ====================================================================
-- Database Schema Extensions for Voice Agent System
-- For Neon Postgres
--
-- NOTE: Uses 'public' schema by default. If using a custom schema,
-- replace 'public.' with your schema name (e.g., 'myapp.')
-- and set DB_SCHEMA environment variable to match.
-- ====================================================================

-- ====================================================================
-- Extend public.users table with prompt customization fields
-- ====================================================================

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS business_name VARCHAR(255);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS industry VARCHAR(100);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS service_types JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS business_qa JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS callback_window VARCHAR(100) DEFAULT 'within 2 hours';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS notification_phone VARCHAR(20);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255);

-- Index for fast lookup by Twilio phone number
CREATE INDEX IF NOT EXISTS idx_users_twilio_phone_number ON public.users(twilio_phone_number);

-- ====================================================================
-- Extend public.calls table with recording URL
-- ====================================================================

ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS recording_url VARCHAR(500);

-- Index for recording webhook lookup
CREATE INDEX IF NOT EXISTS idx_calls_twilio_call_sid ON public.calls(twilio_call_sid);

-- ====================================================================
-- Example: Update an existing user with prompt variables
-- ====================================================================

-- UNCOMMENT AND CUSTOMIZE THIS SECTION TO ADD YOUR DATA:

/*
UPDATE public.users
SET
  business_name = 'ABC Plumbing',
  industry = 'plumbing',
  service_types = '["emergency plumbing", "drain cleaning", "water heater repair"]'::jsonb,
  business_qa = '{
    "Do you work weekends?": "Yes, 24/7 including holidays",
    "How much does it cost?": "Most jobs are $150-500",
    "How soon can someone come?": "Usually within 1-2 hours for emergencies"
  }'::jsonb,
  callback_window = 'within 2 hours for emergencies',
  notification_phone = '+15559876543',
  notification_email = 'owner@abcplumbing.com'
WHERE user_id = 'your-user-uuid-here';
*/

-- ====================================================================
-- Verify your changes
-- ====================================================================

-- View user configuration:
-- SELECT user_id, business_name, industry, service_types, business_qa, twilio_phone_number FROM public.users;

-- View calls with recordings:
-- SELECT call_id, user_id, caller_phone, duration_seconds, recording_url FROM public.calls ORDER BY created_at DESC LIMIT 10;
