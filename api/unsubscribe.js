const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  const { user } = req.query;

  if (!user) {
    return res.status(400).send('Missing user parameter.');
  }

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ active: false })
      .eq('id', user);

    if (error) {
      console.error('Unsubscribe error:', error);
      return res.status(500).send('Failed to unsubscribe.');
    }

    res.redirect(302, '/thanks.html');
  } catch (err) {
    console.error('Unsubscribe handler error:', err);
    res.status(500).send('Internal error.');
  }
};
