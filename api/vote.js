const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  const { user, item, vote } = req.query;

  if (!user || !item || !['up', 'down'].includes(vote)) {
    return res.status(400).send('Invalid parameters. Required: user, item, vote (up|down)');
  }

  try {
    // Record the vote
    const { error } = await supabase.from('votes').upsert({
      user_id: user,
      ordinance_id: item,
      vote,
      voted_at: new Date().toISOString()
    }, { onConflict: 'user_id,ordinance_id' });

    if (error) {
      console.error('Vote error:', error);
      return res.status(500).send('Failed to record vote');
    }

    // Fetch profile ward and ordinance title for the email draft
    const [profileRes, ordRes] = await Promise.all([
      supabase.from('profiles').select('ward').eq('id', user).single(),
      supabase.from('ordinances').select('title, ordinance_num').eq('id', item).single()
    ]);

    const ward = profileRes.data?.ward || '';
    const title = ordRes.data?.title || ordRes.data?.ordinance_num || '';

    // Redirect with context for the thanks page to build the mailto
    const params = new URLSearchParams({
      vote,
      ward,
      title
    });

    res.redirect(302, `/thanks.html?${params.toString()}`);
  } catch (err) {
    console.error('Vote handler error:', err);
    res.status(500).send('Internal error');
  }
};
