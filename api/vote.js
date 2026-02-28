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

    // Redirect to a simple confirmation page
    res.redirect(302, '/thanks.html');
  } catch (err) {
    console.error('Vote handler error:', err);
    res.status(500).send('Internal error');
  }
};
