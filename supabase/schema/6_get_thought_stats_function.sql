CREATE OR REPLACE FUNCTION get_thought_stats()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    result jsonb;
BEGIN
    WITH type_counts AS (
        -- Tally occurrences of each thought type
        SELECT metadata->>'type' as key, count(*)::int as val
        FROM thoughts
        WHERE metadata->>'type' IS NOT NULL
        GROUP BY 1
        ORDER BY val DESC
        LIMIT 10
    ),
    topic_counts AS (
        -- Unnest the topics array and tally each unique tag
        SELECT jsonb_array_elements_text(COALESCE(metadata->'topics', '[]'::jsonb)) as key, count(*)::int as val
        FROM thoughts
        GROUP BY 1
        ORDER BY val DESC
        LIMIT 10
    ),
    people_counts AS (
        -- Unnest the people array and tally each unique name
        SELECT jsonb_array_elements_text(COALESCE(metadata->'people', '[]'::jsonb)) as key, count(*)::int as val
        FROM thoughts
        GROUP BY 1
        ORDER BY val DESC
        LIMIT 10
    ),
    overall AS (
        -- Get the total count and the temporal boundaries of the brain
        SELECT
            count(*)::int as total,
            min(created_at) as oldest,
            max(created_at) as newest
        FROM thoughts
    )
    SELECT jsonb_build_object(
        'total', o.total,
        'oldest', o.oldest,
        'newest', o.newest,
        'types', COALESCE((SELECT jsonb_object_agg(key, val) FROM type_counts), '{}'::jsonb),
        'topics', COALESCE((SELECT jsonb_object_agg(key, val) FROM topic_counts), '{}'::jsonb),
        'people', COALESCE((SELECT jsonb_object_agg(key, val) FROM people_counts), '{}'::jsonb)
    ) INTO result
    FROM overall o;

    RETURN result;
END;
$$;