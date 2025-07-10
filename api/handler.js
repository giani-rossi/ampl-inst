const fetch = require('node-fetch');

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { amplemarketToken, instantlyToken } = req.body;

    if (!amplemarketToken || !instantlyToken) {
      return res.status(400).json({ error: 'Missing required tokens' });
    }

    const result = await syncAmplemarketToInstantly(amplemarketToken, instantlyToken);
    return res.status(200).json(result);

  } catch (error) {
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
};

async function syncAmplemarketToInstantly(amplemarketToken, instantlyToken) {
  const results = {
    processed: [],
    skipped: [],
    errors: [],
    totalLeads: 0,
    debug: {}
  };

  try {
    const leadLists = await fetchAmplemarketLists(amplemarketToken);
    results.debug.listsCount = leadLists.length;
    results.debug.sampleList = leadLists[0];

    const instantlyCampaigns = await fetchInstantlyCampaigns(instantlyToken);
    results.debug.campaignsCount = instantlyCampaigns.length;

    const campaignMap = new Map();
    instantlyCampaigns.forEach(c => campaignMap.set(c.name.toLowerCase(), c));

    for (const list of leadLists) {
      const matchingCampaign = campaignMap.get(list.name.toLowerCase());
      if (!matchingCampaign) {
        results.skipped.push({ listName: list.name, reason: 'No matching campaign in Instantly' });
        continue;
      }

      try {
        const leads = await fetchAmplemarketListDetails(amplemarketToken, list.id);
        if (!Array.isArray(leads) || leads.length === 0) {
          results.skipped.push({ listName: list.name, reason: 'No leads in list' });
          continue;
        }

        const importResult = await sendLeadsToInstantly(instantlyToken, matchingCampaign.id, leads);
        results.processed.push({ listName: list.name, leadsCount: leads.length, campaignId: matchingCampaign.id, importResult });
        results.totalLeads += leads.length;

      } catch (err) {
        results.errors.push({ listName: list.name, error: err.message });
      }
    }
  } catch (err) {
    results.errors.push({ general: err.message });
  }

  return results;
}

async function fetchAmplemarketLists(token) {
  const response = await fetch('https://api.amplemarket.com/lead-lists', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json();
  return data.lead_lists || [];
}

async function fetchAmplemarketListDetails(token, listId) {
  const response = await fetch(`https://api.amplemarket.com/lead-lists/${listId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Amplemarket list fetch failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.leads || [];
}

async function fetchInstantlyCampaigns(token) {
  const all = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(`https://api.instantly.ai/api/v2/campaigns?skip=${skip}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    const items = data.items || [];
    all.push(...items);
    if (items.length < limit) break;
    skip += limit;
  }

  return all;
}

async function sendLeadsToInstantly(token, campaignId, leads) {
  const formattedLeads = leads.map(lead => ({
    email: lead.email,
    first_name: lead.first_name || '',
    last_name: lead.last_name || '',
    company_name: lead.company_name || '',
    title: lead.title || '',
    linkedin_url: lead.linkedin_url || '',
    custom_variables: {
      list_id: lead.list_id || '',
      lead_id: lead.id || '',
      source: 'amplemarket'
    }
  })).filter(lead => lead.email);

  const chunks = [];
  for (let i = 0; i < formattedLeads.length; i += 1000) {
    chunks.push(formattedLeads.slice(i, i + 1000));
  }

  const results = [];
  for (const chunk of chunks) {
    const res = await fetch(`https://api.instantly.ai/api/v1/lead/add?api_key=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign_id: campaignId,
        leads: chunk,
        skip_if_in_workspace: true
      })
    });
    const data = await res.json();
    results.push(data);
  }

  return { totalLeads: formattedLeads.length, results };
}
