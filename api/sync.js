// Backend function for Cloudflare Worker / Vercel Function
// This handles the sync between Amplemarket and Instantly

// For Cloudflare Worker
export default {
  async fetch(request, env, ctx) {
    // Handle CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Add debug endpoint
    const url = new URL(request.url);
    if (url.pathname === '/debug' && request.method === 'POST') {
      return handleDebug(request, env);
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const { amplemarketToken, instantlyToken } = await request.json();
      
      // Use provided tokens or fallback to environment variables
      const AMPLEMARKET_API_TOKEN = amplemarketToken || env.AMPLEMARKET_API_TOKEN;
      const INSTANTLY_API_TOKEN = instantlyToken || env.INSTANTLY_API_TOKEN;

      const result = await syncAmplemarketToInstantly(
        AMPLEMARKET_API_TOKEN,
        INSTANTLY_API_TOKEN,
        env.PROCESSED_LISTS // KV namespace for Cloudflare
      );

      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};

// Debug endpoint to test API connections
async function handleDebug(request, env) {
  try {
    const { amplemarketToken, instantlyToken, action } = await request.json();
    
    const AMPLEMARKET_API_TOKEN = amplemarketToken || env.AMPLEMARKET_API_TOKEN;
    const INSTANTLY_API_TOKEN = instantlyToken || env.INSTANTLY_API_TOKEN;
    
    let result = {};
    
    if (action === 'test-amplemarket' || !action) {
      try {
        // Test with a small page size to avoid timeout
        const url = new URL('https://api.amplemarket.com/v1/lead-lists');
        url.searchParams.append('page_size', '10');
        
        const response = await fetch(url.toString(), {
          headers: {
            'Authorization': `Bearer ${AMPLEMARKET_API_TOKEN}`,
            'Accept': 'application/json'
          }
        });
        
        const responseText = await response.text();
        
        if (!response.ok) {
          result.amplemarket = {
            success: false,
            error: `API returned ${response.status}`,
            response: responseText.substring(0, 500)
          };
        } else {
          const data = JSON.parse(responseText);
          result.amplemarket = {
            success: true,
            hasItems: !!(data.items && data.items.length > 0),
            itemsCount: data.items ? data.items.length : 0,
            firstItem: data.items ? data.items[0] : null,
            pageAfter: data.page_after || null,
            responseStructure: {
              hasItems: !!data.items,
              isArray: Array.isArray(data),
              keys: Object.keys(data)
            }
          };
        }
      } catch (error) {
        result.amplemarket = {
          success: false,
          error: error.message,
          stack: error.stack
        };
      }
    }
    
    if (action === 'test-instantly' || !action) {
      try {
        const response = await fetch(
          `https://api.instantly.ai/api/v2/campaigns?api_key=${INSTANTLY_API_TOKEN}&skip=0&limit=10`,
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json'
            }
          }
        );
        
        const responseText = await response.text();
        
        if (!response.ok) {
          result.instantly = {
            success: false,
            error: `API returned ${response.status}`,
            response: responseText.substring(0, 500)
          };
        } else {
          const campaigns = JSON.parse(responseText);
          result.instantly = {
            success: true,
            campaignsCount: Array.isArray(campaigns) ? campaigns.length : 0,
            firstCampaign: Array.isArray(campaigns) ? campaigns[0] : null,
            responseType: Array.isArray(campaigns) ? 'array' : typeof campaigns,
            sampleCampaignName: Array.isArray(campaigns) && campaigns[0] ? campaigns[0].name : null
          };
        }
      } catch (error) {
        result.instantly = {
          success: false,
          error: error.message,
          stack: error.stack
        };
      }
    }
    
    return new Response(JSON.stringify(result, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// For Vercel Function, export this instead:
/*
export async function POST(request) {
  try {
    const { amplemarketToken, instantlyToken } = await request.json();
    
    const AMPLEMARKET_API_TOKEN = amplemarketToken || process.env.AMPLEMARKET_API_TOKEN;
    const INSTANTLY_API_TOKEN = instantlyToken || process.env.INSTANTLY_API_TOKEN;

    const result = await syncAmplemarketToInstantly(
      AMPLEMARKET_API_TOKEN,
      INSTANTLY_API_TOKEN,
      null // For Vercel, we'll use in-memory storage
    );

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
*/

// Main sync function
async function syncAmplemarketToInstantly(amplemarketToken, instantlyToken, kvStore) {
  const results = {
    processed: [],
    skipped: [],
    errors: [],
    totalLeads: 0,
    debug: {} // Add debug info
  };

  try {
    // Step 1: Fetch all lead lists from Amplemarket
    console.log('Fetching Amplemarket lists...');
    const leadLists = await fetchAmplemarketLists(amplemarketToken);
    results.debug.listsCount = leadLists.length;
    results.debug.sampleList = leadLists[0]; // Store first list for debugging
    
    if (!Array.isArray(leadLists) || leadLists.length === 0) {
      results.debug.listsResponse = leadLists;
      return {
        ...results,
        errors: [{ general: 'No lists found in Amplemarket or unexpected response format' }]
      };
    }
    
    // Step 2: Fetch all campaigns from Instantly
    console.log('Fetching Instantly campaigns...');
    const instantlyCampaigns = await fetchInstantlyCampaigns(instantlyToken);
    results.debug.campaignsCount = instantlyCampaigns.length;
    
    // Create a map of campaign names for quick lookup
    const campaignMap = new Map();
    instantlyCampaigns.forEach(campaign => {
      campaignMap.set(campaign.name.toLowerCase(), campaign);
    });

    // Step 3: Process each lead list
    for (const list of leadLists) {
      // Ensure list has required properties
      if (!list.id || !list.name) {
        results.errors.push({
          listName: list.name || 'Unknown',
          error: 'List missing required properties (id or name)'
        });
        continue;
      }
      
      const listKey = `list_${list.id}`;
      
      // Check if we've already processed this list
      if (kvStore) {
        const processed = await kvStore.get(listKey);
        if (processed) {
          results.skipped.push({
            listName: list.name,
            reason: 'Already processed',
            processedAt: processed
          });
          continue;
        }
      }

      // Check if matching campaign exists in Instantly
      const matchingCampaign = campaignMap.get(list.name.toLowerCase());
      
      if (!matchingCampaign) {
        results.skipped.push({
          listName: list.name,
          reason: 'No matching campaign in Instantly'
        });
        continue;
      }

      try {
        // Fetch leads from this list
        const leads = await fetchAmplemarketLeads(amplemarketToken, list.id);
        
        if (leads.length === 0) {
          results.skipped.push({
            listName: list.name,
            reason: 'No leads in list'
          });
          continue;
        }
        
        // Send leads to Instantly campaign
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

        // Mark this list as processed
        if (kvStore) {
          await kvStore.put(listKey, new Date().toISOString(), {
            expirationTtl: 86400 * 30 // 30 days
          });
        }

      } catch (error) {
        results.errors.push({
          listName: list.name,
          error: error.message
        });
      }
    }

  } catch (error) {
    results.errors.push({
      general: error.message,
      stack: error.stack
    });
  }

  return results;
}

// Amplemarket API functions
async function fetchAmplemarketLists(apiToken) {
  const allLists = [];
  let pageAfter = null;
  const pageSize = 100;
  
  // Amplemarket uses pagination with page_after parameter
  do {
    const url = new URL('https://api.amplemarket.com/v1/lead-lists');
    url.searchParams.append('page_size', pageSize);
    if (pageAfter) {
      url.searchParams.append('page_after', pageAfter);
    }
    
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
    
    // Debug logging
    console.log('Amplemarket Lists Response:', JSON.stringify(data).substring(0, 500));
    
    // Handle the response structure
    if (data.items && Array.isArray(data.items)) {
      allLists.push(...data.items);
    } else if (Array.isArray(data)) {
      allLists.push(...data);
    } else {
      console.error('Unexpected Amplemarket response structure:', data);
      throw new Error(`Unexpected Amplemarket API response structure. Response: ${JSON.stringify(data).substring(0, 200)}`);
    }
    
    // Check for next page
    pageAfter = data.page_after || null;
    
  } while (pageAfter);
  
  return allLists;
}

async function fetchAmplemarketLeads(apiToken, listId) {
  const leads = [];
  let pageAfter = null;
  const pageSize = 100;

  do {
    const url = new URL(`https://api.amplemarket.com/v1/lead-lists/${listId}/leads`);
    url.searchParams.append('page_size', pageSize);
    if (pageAfter) {
      url.searchParams.append('page_after', pageAfter);
    }
    
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
    
    // Handle the response structure
    if (data.items && Array.isArray(data.items)) {
      leads.push(...data.items);
    } else if (Array.isArray(data)) {
      leads.push(...data);
    } else {
      console.error('Unexpected leads response structure:', data);
      break;
    }
    
    // Check for next page
    pageAfter = data.page_after || null;
    
  } while (pageAfter);

  return leads;
}

// Instantly API functions
async function fetchInstantlyCampaigns(apiKey) {
  const allCampaigns = [];
  let skip = 0;
  const limit = 100;
  
  // Instantly v2 API uses skip/limit pagination
  do {
    const response = await fetch(
      `https://api.instantly.ai/api/v2/campaigns?api_key=${apiKey}&skip=${skip}&limit=${limit}`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Instantly API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // v2 API returns campaigns directly as an array
    if (Array.isArray(data)) {
      allCampaigns.push(...data);
      skip += data.length;
      
      // Continue if we got a full page
      if (data.length < limit) {
        break;
      }
    } else {
      console.error('Unexpected Instantly response:', data);
      break;
    }
    
  } while (true);
  
  return allCampaigns;
}

async function sendLeadsToInstantly(apiKey, campaignId, leads) {
  // Transform leads to Instantly format
  const instantlyLeads = leads.map(lead => ({
    email: lead.email || lead.work_email || '', // Amplemarket might use work_email
    first_name: lead.first_name || lead.firstName || '',
    last_name: lead.last_name || lead.lastName || '',
    company_name: lead.company || lead.company_name || lead.organization || '',
    title: lead.title || lead.job_title || '',
    linkedin_url: lead.linkedin || lead.linkedin_url || lead.social_url || '',
    // Add any custom variables if needed
    custom_variables: {
      source: 'amplemarket',
      list_id: lead.list_id || '',
      lead_id: lead.id || ''
    }
  }));

  // Filter out leads without email
  const validLeads = instantlyLeads.filter(lead => lead.email);
  
  if (validLeads.length === 0) {
    return { message: 'No valid leads with email addresses found' };
  }

  // Instantly has a limit of 1000 leads per request
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
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          campaign_id: campaignId,
          leads: chunk,
          skip_if_in_workspace: true // Avoid duplicates
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
    results: results
  };
}
