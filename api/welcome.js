const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const { buildWelcomeHtml, buildWelcomeDigest } = require('../scripts/send-digest');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: 'userId is required.' });
  }

  try {
    // Fetch the full subscriber profile (need all fields for Claude analysis)
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (profileErr || !profile) {
      return res.status(404).json({ error: 'Subscriber not found.' });
    }

    if (!profile.ward) {
      return res.status(400).json({ error: 'Subscriber has no ward — cannot send welcome email.' });
    }

    // Run Claude analysis and send welcome email (awaited so Vercel keeps function alive)
    const { items, devNotices, notices, weekDate } = await buildWelcomeDigest(profile, supabase);
    const html = buildWelcomeHtml(profile, items, weekDate, devNotices, notices);
    const { data: emailResult, error: emailErr } = await resend.emails.send({
      from: 'MyBloc <digest@mybloc.co>',
      to: [profile.email],
      subject: `Welcome to MyBloc — here's what's happening in Ward ${profile.ward}`,
      html
    });

    if (emailErr) {
      throw new Error(JSON.stringify(emailErr));
    }

    return res.status(200).json({ success: true, emailId: emailResult.id });
  } catch (err) {
    console.error('Welcome email error:', err);
    return res.status(500).json({ error: 'Failed to send welcome email.' });
  }
};
