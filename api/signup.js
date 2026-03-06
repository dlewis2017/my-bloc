const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VALID_WARDS = ['A', 'B', 'C', 'D', 'E', 'F'];
const VALID_HOUSING = ['Renter', 'Homeowner', 'Section 8'];
const VALID_TRANSPORT = ['No car', 'Car owner', 'Transit dependent'];
const VALID_INTERESTS = [
  'rent control', 'property tax', 'parking', 'noise', 'utilities',
  'transit', 'bike lanes', 'roads', 'sidewalks',
  'schools', 'parks', 'public safety', 'senior services', 'youth programs',
  'development', 'zoning', 'jobs', 'small business', 'affordable housing'
];
const VALID_INCOME = ['Under $50K', '$50K-$100K', '$100K-$200K', 'Over $200K'];


module.exports = async function handler(req, res) {
  // CORS headers for frontend fetch
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, city, ward, housing, transport, income, has_kids, interests, waitlist } = req.body || {};

  // Validate email
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  // Waitlist signup — only need email and city
  if (waitlist) {
    try {
      const { data, error } = await supabase.from('profiles').insert({
        email: email.toLowerCase().trim(),
        city: city || 'Unknown',
        active: false
      }).select('id').single();

      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'This email is already on our list.' });
        }
        console.error('Waitlist error:', error);
        return res.status(500).json({ error: 'Failed to join waitlist.' });
      }

      return res.status(200).json({ success: true, id: data.id, waitlist: true });
    } catch (err) {
      console.error('Waitlist handler error:', err);
      return res.status(500).json({ error: 'Internal error.' });
    }
  }

  // Validate ward
  if (!ward || !VALID_WARDS.includes(ward)) {
    return res.status(400).json({ error: `Ward must be one of: ${VALID_WARDS.join(', ')}` });
  }

  // Validate housing
  if (!housing || !VALID_HOUSING.includes(housing)) {
    return res.status(400).json({ error: `Housing must be one of: ${VALID_HOUSING.join(', ')}` });
  }

  // Validate transport
  if (!transport || !VALID_TRANSPORT.includes(transport)) {
    return res.status(400).json({ error: `Transport must be one of: ${VALID_TRANSPORT.join(', ')}` });
  }

  // Validate interests (optional, but must be from allowed list)
  const validatedInterests = Array.isArray(interests)
    ? interests.filter(i => VALID_INTERESTS.includes(i))
    : [];

  const profileFields = {
    email: email.toLowerCase().trim(),
    ward, housing, transport,
    has_kids: Boolean(has_kids),
    income: income && VALID_INCOME.includes(income) ? income : null,
    interests: validatedInterests
  };

  try {
    const { data, error } = await supabase.from('profiles').insert({
      ...profileFields,
      city: city || 'Jersey City',
      active: true
    }).select('id').single();

    if (error) {
      if (error.code === '23505') {
        // Check if the existing profile is inactive — if so, re-activate it
        const { data: existing } = await supabase
          .from('profiles')
          .select('id, active')
          .eq('email', email.toLowerCase().trim())
          .single();

        if (existing && !existing.active) {
          const { data: updated, error: updateErr } = await supabase
            .from('profiles')
            .update({ ...profileFields, active: true })
            .eq('id', existing.id)
            .select('id')
            .single();

          if (updateErr) {
            console.error('Re-subscribe error:', updateErr);
            return res.status(500).json({ error: 'Failed to re-subscribe.' });
          }

          return res.status(200).json({ success: true, id: updated.id });
        }

        return res.status(409).json({ error: 'This email is already subscribed.' });
      }
      console.error('Signup error:', error);
      return res.status(500).json({ error: 'Failed to create subscription.' });
    }

    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error('Signup handler error:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
};
