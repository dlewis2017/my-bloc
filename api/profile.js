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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { user } = req.query;

  if (!user) {
    return res.status(400).json({ error: 'Missing user parameter.' });
  }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, ward, housing, transport, income, has_kids, interests, active')
      .eq('id', user)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    return res.status(200).json(data);
  }

  if (req.method === 'PUT') {
    const { ward, housing, transport, income, has_kids, interests } = req.body || {};

    const updates = {};

    if (ward) {
      if (!VALID_WARDS.includes(ward)) {
        return res.status(400).json({ error: `Ward must be one of: ${VALID_WARDS.join(', ')}` });
      }
      updates.ward = ward;
    }

    if (housing) {
      if (!VALID_HOUSING.includes(housing)) {
        return res.status(400).json({ error: `Housing must be one of: ${VALID_HOUSING.join(', ')}` });
      }
      updates.housing = housing;
    }

    if (transport) {
      if (!VALID_TRANSPORT.includes(transport)) {
        return res.status(400).json({ error: `Transport must be one of: ${VALID_TRANSPORT.join(', ')}` });
      }
      updates.transport = transport;
    }

    if (income !== undefined) {
      updates.income = income && VALID_INCOME.includes(income) ? income : null;
    }

    if (has_kids !== undefined) {
      updates.has_kids = Boolean(has_kids);
    }

    if (interests !== undefined) {
      updates.interests = Array.isArray(interests)
        ? interests.filter(i => VALID_INTERESTS.includes(i))
        : [];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    const { error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', user);

    if (error) {
      console.error('Profile update error:', error);
      return res.status(500).json({ error: 'Failed to update profile.' });
    }

    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};
