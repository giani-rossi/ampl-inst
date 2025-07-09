export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { amplemarketToken, instantlyToken } = req.body;

    if (!amplemarketToken || !instantlyToken) {
      return res.status(400).json({ error: 'Missing API tokens' });
    }

    const fetchLists = await fetch('https://api.amplemarket.com/v1/lists', {
      headers: { 'Authorization': `Bearer ${amplemarketToken}` }
    });

    const lists = await fetchLists.json();
    const fetchCampaigns = await fetch('https://api.instantly.ai/api/v1/campaign/list', {
      headers: { 'x-api-key': instantlyToken }
    });

    const campaigns = await fetchCampaigns.json();
    const results = { processed: [], skipped: [], errors: [], totalLeads: 0 };

    for (const list of lists) {
      const campaign = campaigns.find(c => c.name.toLowerCase() === list.name.toLowerCase());

      if (!campaign) {
        results.skipped.push({ listName: list.name, reason: 'No matching campaign found' });
        continue;
      }

      try {
        const leadsRes = await fetch(`https://api.amplemarket.com/v1/lists/${list.id}/leads`, {
          headers: { 'Authorization': `Bearer ${amplemarketToken}` }
        });

        const leads = await leadsRes.json();

        if (!leads.length) {
          results.skipped.push({ listName: list.name, reason: 'No leads in list' });
          continue;
        }

        const batched = [];
        for (let i = 0; i < leads.length; i += 1000) {
          batched.push(leads.slice(i, i + 1000));
        }

        for (const batch of batched) {
          await fetch('https://api.instantly.ai/api/v1/lead/add', {
            method: 'POST',
            headers: {
              'x-api-key': instantlyToken,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              campaignId: campaign.id,
              leads: batch.map(l => ({
                email: l.email,
                firstName: l.first_name,
                lastName: l.last_name,
                companyName: l.company_name,
                customFields: l.custom_fields || {}
              }))
            })
          });
        }

        results.processed.push({
          listName: list.name,
          campaignName: campaign.name,
          leadsCount: leads.length
        });

        results.totalLeads += leads.length;
      } catch (err) {
        results.errors.push({ listName: list.name, error: err.message });
      }
    }

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
