export async function POST(request) {
  try {
    const { amplemarketToken, instantlyToken } = await request.json();

    const result = await syncAmplemarketToInstantly(amplemarketToken, instantlyToken);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Main sync function
async function syncAmplemarketToInstantly(amplemarketToken, instantlyToken) {
  const results = {
    processed: [],
    skipped: [],
    errors: [],
    totalLeads: 0,
    debug: {}
  };

  try {
    // Step 1: Fetch all lead lists from Amplemarket
    const leadLists = await fetchAmplemarketLists(amplemarketToken);
    results.debug.listsCount = leadLists.length;
    results.debug.sampleList = leadLists[0];

    if (!Array.isArray(leadLists) || leadLists.length === 0) {
      results.debug.listsResponse = leadLists;
      return {
        ...results,
        errors: [{ general: 'No lists found in Amplemarket or unexpected response format' }]
      };
    }

    // Step 2: Fetch all campaigns from Instantly
    const instantlyCampaigns = await fetchInstantlyCampaigns(instantlyToken);
    results.debug.campaignsCount = instantlyCampaigns.length;

    const campaignMap = new Map();
    instantlyCampaigns.forEach(campaign => {
      campaignMap.set(campaign.name.toLowerCase(), campaign);
    });

    // Step 3: Process each lead list
    for (const list of leadLists) {
      if (!list.id || !list.name) {
        results.errors.push({
          listName: list.name || 'Unknown',
          error: 'List missing required properties (id or name)'
        });
        continue;
      }

      const matchingCampaign = campaignMap.get(list.name.toLowerCase());

      if (!matchingCampaign) {
        results.skipped.push({
          listName: list.name,
          reason: 'No matching campaign in Instantly'
        });
        continue;
      }

      try {
        const leads = await fetchAmplemarketLeads(amplemarketToken, list.id);

        if (leads.length === 0) {
          results.skipped.push({
            listName: list.name,
            reason: 'No leads in list'
          });
          continue;
        }

        const importResult = await sendLeadsToInstantly(
          instantlyToken,
          matchingCampaign.id,
          leads
        );

        results.processed.push({
          listName: list.name,
          campaignName: matchingCampaign.name,
          leadsCount: leads.length,
          importResult
        });

        results.totalLeads += leads.length;

      } catch (error) {
        results.errors.push({
          listName: list.name,
          error: error.message
        });
      }
    }

  } catch (error) {
    results.errors.push({ general: error.message, stack: error.stack });
  }

  return results;
}

// Helpers
async function fetchAmplemarketLists(apiToken) {
  const allLists = [];
  let pageAfter = null;
  const pageSize = 100;

  do {
    const url = new URL('https://api.amplemarket.com/lead-lists');
    url.searchParams.append('page_size', pageSize);
    if (pageAfter) url.searchParams.append('page_after', pageAfter);

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Amplemarket API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.items && Array.isArray(data.items)) {
      allLists.push(...data.items);
    } else if (Array.isArray(data)) {
      allLists.push(...data);
    } else {
      throw new Error(`Unexpected Amplemarket response format`);
    }

    pageAfter = data.page_after || null;
  } while (pageAfter);

  return allLists;
}

async function fetchAmplemarketLeads(apiToken, listId) {
  const leads = [];
  let pageAfter = null;
  const pageSize = 100;

  do {
    const url = new URL(`https://api.amplemarket.com/lead-lists/${listId}/leads`);
    url.searchParams.append('page_size', pageSize);
    if (pageAfter) url.searchParams.append('page_after', pageAfter);

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Amplemarket API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.items && Array.isArray(data.items)) {
      leads.push(...data.items);
    } else if (Array.isArray(data)) {
      leads.push(...data);
    } else {
      break;
    }

    pageAfter = data.page_after || null;
  } while (pageAfter);

  return leads;
}

async function fetchInstantlyCampaigns(apiKey) {
  const allCampaigns = [];
  let skip = 0;
  const limit = 100;

  do {
    const response = await fetch(
      `https://api.instantly.ai/api/v2/campaigns?api_key=${apiKey}&skip=${skip}&limit=${limit}`,
      { method: 'GET', headers: { 'Accept': 'application/json' } }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Instantly API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (Array.isArray(data)) {
      allCampaigns.push(...data);
      skip += data.length;
      if (data.length < limit) break;
    } else {
      break;
    }
  } while (true);

  return allCampaigns;
}

async function sendLeadsToInstantly(apiKey, campaignId, leads) {
  const instantlyLeads = leads.map(lead => ({
    email: lead.email || lead.work_email || '',
    first_name: lead.first_name || lead.firstName || '',
    last_name: lead.last_name || lead.lastName || '',
    company_name: lead.company || lead.company_name || lead.organization || '',
    title: lead.title || lead.job_title || '',
    linkedin_url: lead.linkedin || lead.linkedin_url || lead.social_url || '',
    custom_variables: {
      source: 'amplemarket',
      list_id: lead.list_id || '',
      lead_id: lead.id || ''
    }
  }));

  const validLeads = instantlyLeads.filter(lead => lead.email);
  if (validLeads.length === 0) return { message: 'No valid leads with email' };

  const chunks = [];
  for (let i = 0; i < validLeads.length; i += 1000) {
    chunks.push(validLeads.slice(i, i + 1000));
  }

  const results = [];

  for (const chunk of chunks) {
    const response = await fetch(
      `https://api.instantly.ai/api/v1/lead/add?api_key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaign_id: campaignId,
          leads: chunk,
          skip_if_in_workspace: true
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Instantly API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    results.push(result);
  }

  return {
    chunks: results.length,
    totalLeads: validLeads.length,
    results
  };
}
