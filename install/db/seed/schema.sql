--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gin; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;


--
-- Name: EXTENSION btree_gin; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gin IS 'support for indexing common datatypes in GIN';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;


--
-- Name: EXTENSION unaccent; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';


--
-- Name: sino; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sino AS ENUM (
    'si',
    'no'
);


--
-- Name: f_like_literal(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.f_like_literal(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$ SELECT regexp_replace($1, '([\\%_])', '\\\1', 'g') $_$;


--
-- Name: f_regex_literal(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.f_regex_literal(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$ SELECT regexp_replace($1, '([.*+?\[\]{}()|\\^$])', '\\\1', 'g') $_$;


--
-- Name: f_unaccent(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.f_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
			SELECT public.unaccent('public.unaccent', $1)
			$_$;


--
-- Name: jsonb_values_as_text(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jsonb_values_as_text(j jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
   SELECT string_agg(value, ' ')
   FROM jsonb_each_text(j)
  $$;


--
-- Name: matrix_relation_index_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.matrix_relation_index_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        DELETE FROM public.matrix_relation_index WHERE section_tipo = OLD.section_tipo AND section_id = OLD.section_id;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.relation IS NOT NULL THEN
        INSERT INTO public.matrix_relation_index (section_tipo, section_id, from_component_tipo, type, target_section_tipo, target_section_id)
        SELECT NEW.section_tipo, NEW.section_id, kv.key, e->>'type', e->>'section_tipo', (e->>'section_id')::int
        FROM jsonb_each(NEW.relation) AS kv, jsonb_array_elements(kv.value) AS e
        WHERE jsonb_typeof(kv.value) = 'array' AND e->>'section_tipo' IS NOT NULL AND e->>'section_id' ~ '^-?[0-9]+$';
    END IF;
    RETURN NULL;
END $_$;


--
-- Name: matrix_string_search_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.matrix_string_search_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        DELETE FROM public.matrix_string_search WHERE section_tipo = OLD.section_tipo AND section_id = OLD.section_id;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.string IS NOT NULL THEN
        INSERT INTO public.matrix_string_search (section_tipo, section_id, component_tipo, string)
        SELECT NEW.section_tipo, NEW.section_id, kv.key, lower(public.f_unaccent(e->>'value'))
        FROM jsonb_each(NEW.string) AS kv, jsonb_array_elements(kv.value) AS e
        WHERE jsonb_typeof(kv.value) = 'array' AND e->>'value' IS NOT NULL AND e->>'value' <> '';
    END IF;
    RETURN NULL;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: dd_ontology; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dd_ontology (
    id integer NOT NULL,
    tipo character varying(32),
    parent character varying(32),
    term jsonb,
    model text,
    order_number numeric(4,0),
    relations jsonb,
    tld character varying(32),
    properties jsonb,
    model_tipo character varying(8),
    is_model boolean,
    is_translatable boolean,
    is_main boolean,
    propiedades text,
    machine_name text,
    use_machine_name boolean
);


--
-- Name: TABLE dd_ontology; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dd_ontology IS 'Active ontology';


--
-- Name: COLUMN dd_ontology.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.id IS 'Unique table identifier';


--
-- Name: COLUMN dd_ontology.tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.tipo IS 'Ontology identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN dd_ontology.parent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.parent IS 'Ontology identifier parent (ontology TLD | ontology instance ID, e.g., tch1 = Tangible Cultural Heritage -> Objects)';


--
-- Name: COLUMN dd_ontology.term; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.term IS 'Ontology node names in multiple languages';


--
-- Name: COLUMN dd_ontology.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.model IS 'Ontology model name as section, component_portal, etc.';


--
-- Name: COLUMN dd_ontology.order_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.order_number IS 'Ontology node position order';


--
-- Name: COLUMN dd_ontology.relations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.relations IS 'Direct connections between nodes, unidirectional';


--
-- Name: COLUMN dd_ontology.tld; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.tld IS 'Ontology name space';


--
-- Name: COLUMN dd_ontology.properties; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.properties IS 'Ontology node definition';


--
-- Name: COLUMN dd_ontology.model_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.model_tipo IS 'Ontology identifier for the node type,  e.g., dd6 = section';


--
-- Name: COLUMN dd_ontology.is_model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.is_model IS 'Boolean to identify if the node is a type of nodes';


--
-- Name: COLUMN dd_ontology.is_translatable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.is_translatable IS 'Boolean to identify if the node is a multilingual node';


--
-- Name: COLUMN dd_ontology.is_main; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.is_main IS 'Boolean to identify if the node is a main/root node (tipo = tld + 0)';


--
-- Name: COLUMN dd_ontology.propiedades; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.propiedades IS 'V5 properties, DEPRECATED';


--
-- Name: COLUMN dd_ontology.machine_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.machine_name IS 'Language-free node name (ontology43); NULL unless use_machine_name. Derived by the parser.';


--
-- Name: COLUMN dd_ontology.use_machine_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology.use_machine_name IS 'True: machine_name is the node name (ontology44); false: named by its label (term); NULL: not derived yet.';


--
-- Name: dd_ontology_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dd_ontology_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dd_ontology_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dd_ontology_id_seq OWNED BY public.dd_ontology.id;


--
-- Name: dd_ontology_recovery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dd_ontology_recovery (
    id integer DEFAULT nextval('public.dd_ontology_id_seq'::regclass) CONSTRAINT dd_ontology_id_not_null NOT NULL,
    tipo character varying(32),
    parent character varying(32),
    term jsonb,
    model character varying(256),
    order_number numeric(4,0),
    relations jsonb,
    tld character varying(32),
    properties jsonb,
    model_tipo character varying(8),
    is_model boolean,
    is_translatable boolean,
    propiedades text,
    is_main boolean,
    machine_name text,
    use_machine_name boolean
);


--
-- Name: COLUMN dd_ontology_recovery.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.id IS 'Unique table identifier';


--
-- Name: COLUMN dd_ontology_recovery.tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.tipo IS 'Ontology identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN dd_ontology_recovery.parent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.parent IS 'Ontology identifier parent (ontology TLD | ontology instance ID, e.g., tch1 = Tangible Cultural Heritage -> Objects)';


--
-- Name: COLUMN dd_ontology_recovery.term; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.term IS 'Ontology node names in multiple languages';


--
-- Name: COLUMN dd_ontology_recovery.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.model IS 'Ontology model name as section, componnet_portal, etc.';


--
-- Name: COLUMN dd_ontology_recovery.order_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.order_number IS 'Ontology node position order';


--
-- Name: COLUMN dd_ontology_recovery.relations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.relations IS 'Direct connections between nodes, unidirectional';


--
-- Name: COLUMN dd_ontology_recovery.tld; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.tld IS 'Ontology name space';


--
-- Name: COLUMN dd_ontology_recovery.properties; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.properties IS 'Ontology node definition';


--
-- Name: COLUMN dd_ontology_recovery.model_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.model_tipo IS 'Ontology identifier for the node type,  e.g., dd6 = section';


--
-- Name: COLUMN dd_ontology_recovery.is_model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.is_model IS 'Boolean to identify if the node is a type of nodes';


--
-- Name: COLUMN dd_ontology_recovery.is_translatable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.is_translatable IS 'Boolean to identify if the node is a multilingual node';


--
-- Name: COLUMN dd_ontology_recovery.propiedades; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dd_ontology_recovery.propiedades IS 'V5 properties, DEPRECATED';


--
-- Name: main_dd; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.main_dd (
    id integer NOT NULL,
    tld character varying(32),
    counter integer,
    name character varying(255)
);


--
-- Name: main_dd_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.main_dd_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: main_dd_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.main_dd_id_seq OWNED BY public.main_dd.id;


--
-- Name: matrix_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_id_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix (
    id integer DEFAULT nextval('public.matrix_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix IS 'Main data table';


--
-- Name: COLUMN matrix.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.data IS 'Section data';


--
-- Name: COLUMN matrix.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_activities_id_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_activities (
    id integer DEFAULT nextval('public.matrix_activities_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_activities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_activities IS 'Activities data table';


--
-- Name: COLUMN matrix_activities.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_activities.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_activities.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_activities.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.data IS 'Section data';


--
-- Name: COLUMN matrix_activities.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_activities.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_activities.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_activities.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_activities.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_activities.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_activities.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_activities.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_activities.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_activities.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activities.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_activity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_activity_id_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_activity_section_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_activity_section_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_activity (
    id integer DEFAULT nextval('public.matrix_activity_id_seq'::regclass) NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now(),
    section_id integer DEFAULT nextval('public.matrix_activity_section_id_seq'::regclass),
    section_tipo character varying DEFAULT 'dd542'::character varying NOT NULL,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_activity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_activity IS 'Activity log data table';


--
-- Name: COLUMN matrix_activity.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_activity."timestamp"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity."timestamp" IS 'Activity timestamp (previously date)';


--
-- Name: COLUMN matrix_activity.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_activity.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_activity.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.data IS 'Section data';


--
-- Name: COLUMN matrix_activity.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_activity.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_activity.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_activity.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_activity.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_activity.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_activity.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_activity.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_activity.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_activity.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_activity.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_activity_diffusion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_activity_diffusion (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now(),
    section_id integer NOT NULL,
    section_tipo character varying(255) NOT NULL,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: matrix_activity_diffusion_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_activity_diffusion_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_activity_diffusion_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matrix_activity_diffusion_id_seq OWNED BY public.matrix_activity_diffusion.id;


--
-- Name: matrix_activity_diffusion_section_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_activity_diffusion_section_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_activity_diffusion_section_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matrix_activity_diffusion_section_id_seq OWNED BY public.matrix_activity_diffusion.section_id;


--
-- Name: matrix_counter; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_counter (
    tipo character varying(128) CONSTRAINT matrix_counter_tipo_not_null1 NOT NULL,
    value integer,
    ref text
);


--
-- Name: matrix_counter_dd; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_counter_dd (
    tipo character varying(128) NOT NULL,
    value integer,
    ref text
);


--
-- Name: matrix_dataframe_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_dataframe_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_dataframe; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_dataframe (
    id integer DEFAULT nextval('public.matrix_dataframe_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: COLUMN matrix_dataframe.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_dataframe.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_dataframe.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_dataframe.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.data IS 'Section data';


--
-- Name: COLUMN matrix_dataframe.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_dataframe.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_dataframe.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_dataframe.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_dataframe.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_dataframe.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_dataframe.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_dataframe.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_dataframe.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_dataframe.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dataframe.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_dd; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_dd (
    id integer NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: COLUMN matrix_dd.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_dd.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_dd.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_dd.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.data IS 'Section data';


--
-- Name: COLUMN matrix_dd.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_dd.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_dd.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_dd.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_dd.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_dd.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_dd.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_dd.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_dd.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_dd.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_dd.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_dd_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_dd_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_dd_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matrix_dd_id_seq OWNED BY public.matrix_dd.id;


--
-- Name: matrix_hierarchy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_hierarchy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_hierarchy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_hierarchy (
    id integer DEFAULT nextval('public.matrix_hierarchy_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_hierarchy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_hierarchy IS 'Thesaurus table';


--
-- Name: COLUMN matrix_hierarchy.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_hierarchy.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_hierarchy.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_hierarchy.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.data IS 'Section data';


--
-- Name: COLUMN matrix_hierarchy.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_hierarchy.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_hierarchy.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_hierarchy.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_hierarchy.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_hierarchy.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_hierarchy.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_hierarchy.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_hierarchy.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_hierarchy.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_hierarchy_main_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_hierarchy_main_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_hierarchy_main; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_hierarchy_main (
    id integer DEFAULT nextval('public.matrix_hierarchy_main_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_hierarchy_main; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_hierarchy_main IS 'Hierarchy definitions table';


--
-- Name: COLUMN matrix_hierarchy_main.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_hierarchy_main.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_hierarchy_main.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_hierarchy_main.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.data IS 'Section data';


--
-- Name: COLUMN matrix_hierarchy_main.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_hierarchy_main.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_hierarchy_main.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_hierarchy_main.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_hierarchy_main.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_hierarchy_main.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_hierarchy_main.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_hierarchy_main.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_hierarchy_main.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_hierarchy_main.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_hierarchy_main.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_indexations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_indexations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_indexations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_indexations (
    id integer DEFAULT nextval('public.matrix_indexations_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_indexations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_indexations IS 'Indexations table';


--
-- Name: COLUMN matrix_indexations.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_indexations.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_indexations.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_indexations.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.data IS 'Section data';


--
-- Name: COLUMN matrix_indexations.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_indexations.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_indexations.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_indexations.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_indexations.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_indexations.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_indexations.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_indexations.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_indexations.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_indexations.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_indexations.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_langs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_langs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_langs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_langs (
    id integer DEFAULT nextval('public.matrix_langs_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_langs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_langs IS 'Langs table';


--
-- Name: COLUMN matrix_langs.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_langs.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_langs.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_langs.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.data IS 'Section data';


--
-- Name: COLUMN matrix_langs.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_langs.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_langs.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_langs.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_langs.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_langs.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_langs.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_langs.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_langs.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_langs.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_langs.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_layout_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_layout_id_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_layout; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_layout (
    id integer DEFAULT nextval('public.matrix_layout_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_layout; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_layout IS 'Layout definitions table';


--
-- Name: COLUMN matrix_layout.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_layout.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_layout.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_layout.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.data IS 'Section data';


--
-- Name: COLUMN matrix_layout.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_layout.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_layout.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_layout.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_layout.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_layout.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_layout.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_layout.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_layout.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_layout.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_layout_dd_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_layout_dd_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_layout_dd; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_layout_dd (
    id integer DEFAULT nextval('public.matrix_layout_dd_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: COLUMN matrix_layout_dd.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_layout_dd.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_layout_dd.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_layout_dd.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.data IS 'Section data';


--
-- Name: COLUMN matrix_layout_dd.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_layout_dd.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_layout_dd.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_layout_dd.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_layout_dd.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_layout_dd.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_layout_dd.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_layout_dd.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_layout_dd.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_layout_dd.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_layout_dd.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_list_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_list_id_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_list (
    id integer DEFAULT nextval('public.matrix_list_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_list; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_list IS 'List of values table (projects does not operate here)';


--
-- Name: COLUMN matrix_list.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_list.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_list.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_list.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.data IS 'Section data';


--
-- Name: COLUMN matrix_list.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_list.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_list.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_list.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_list.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_list.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_list.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_list.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_list.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_list.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_list.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_nexus_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_nexus_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_nexus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_nexus (
    id integer DEFAULT nextval('public.matrix_nexus_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: COLUMN matrix_nexus.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_nexus.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_nexus.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_nexus.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.data IS 'Section data';


--
-- Name: COLUMN matrix_nexus.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_nexus.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_nexus.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_nexus.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_nexus.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_nexus.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_nexus.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_nexus.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_nexus.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_nexus.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_nexus_main_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_nexus_main_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_nexus_main; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_nexus_main (
    id integer DEFAULT nextval('public.matrix_nexus_main_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: COLUMN matrix_nexus_main.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_nexus_main.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_nexus_main.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_nexus_main.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.data IS 'Section data';


--
-- Name: COLUMN matrix_nexus_main.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_nexus_main.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_nexus_main.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_nexus_main.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_nexus_main.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_nexus_main.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_nexus_main.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_nexus_main.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_nexus_main.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_nexus_main.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_nexus_main.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_notes (
    id integer DEFAULT nextval('public.matrix_notes_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_notes IS 'Notes table';


--
-- Name: COLUMN matrix_notes.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_notes.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_notes.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_notes.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.data IS 'Section data';


--
-- Name: COLUMN matrix_notes.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_notes.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_notes.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_notes.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_notes.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_notes.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_notes.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_notes.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_notes.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_notes.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_notes.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE UNLOGGED TABLE public.matrix_notifications (
    id integer NOT NULL,
    data jsonb
);


--
-- Name: TABLE matrix_notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_notifications IS 'Notifications table (lock components)';


--
-- Name: matrix_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE UNLOGGED SEQUENCE public.matrix_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matrix_notifications_id_seq OWNED BY public.matrix_notifications.id;


--
-- Name: matrix_ontology_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_ontology_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_ontology; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_ontology (
    id integer DEFAULT nextval('public.matrix_ontology_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: COLUMN matrix_ontology.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_ontology.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_ontology.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_ontology.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.data IS 'Section data';


--
-- Name: COLUMN matrix_ontology.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_ontology.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_ontology.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_ontology.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_ontology.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_ontology.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_ontology.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_ontology.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_ontology.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_ontology.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_ontology_main_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_ontology_main_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_ontology_main; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_ontology_main (
    id integer DEFAULT nextval('public.matrix_ontology_main_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: COLUMN matrix_ontology_main.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_ontology_main.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_ontology_main.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_ontology_main.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.data IS 'Section data';


--
-- Name: COLUMN matrix_ontology_main.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_ontology_main.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_ontology_main.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_ontology_main.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_ontology_main.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_ontology_main.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_ontology_main.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_ontology_main.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_ontology_main.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_ontology_main.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_ontology_main.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_profiles (
    id integer NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_profiles IS 'User profiles table';


--
-- Name: COLUMN matrix_profiles.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_profiles.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_profiles.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_profiles.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.data IS 'Section data';


--
-- Name: COLUMN matrix_profiles.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_profiles.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_profiles.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_profiles.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_profiles.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_profiles.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_profiles.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_profiles.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_profiles.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_profiles.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_profiles.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matrix_profiles_id_seq OWNED BY public.matrix_profiles.id;


--
-- Name: matrix_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_projects (
    id integer NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_projects; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_projects IS 'Projects table';


--
-- Name: COLUMN matrix_projects.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_projects.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_projects.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_projects.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.data IS 'Section data';


--
-- Name: COLUMN matrix_projects.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_projects.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_projects.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_projects.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_projects.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_projects.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_projects.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_projects.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_projects.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_projects.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_projects.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_projects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_projects_id_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matrix_projects_id_seq OWNED BY public.matrix_projects.id;


--
-- Name: matrix_relation_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_relation_index (
    section_tipo character varying(64) NOT NULL,
    section_id integer NOT NULL,
    from_component_tipo character varying(64) NOT NULL,
    type character varying(64),
    target_section_tipo character varying(64) NOT NULL,
    target_section_id integer NOT NULL
);


--
-- Name: matrix_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_stats_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_stats (
    id integer DEFAULT nextval('public.matrix_stats_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: COLUMN matrix_stats.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_stats.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_stats.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_stats.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.data IS 'Section data';


--
-- Name: COLUMN matrix_stats.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_stats.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_stats.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_stats.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_stats.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_stats.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_stats.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_stats.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_stats.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_stats.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_stats.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_string_search; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_string_search (
    section_tipo character varying(64) NOT NULL,
    section_id integer NOT NULL,
    component_tipo character varying(64) NOT NULL,
    string text NOT NULL
);


--
-- Name: matrix_test_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_test_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_test; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_test (
    id integer DEFAULT nextval('public.matrix_test_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_test; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_test IS 'Test data table';


--
-- Name: COLUMN matrix_test.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_test.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_test.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_test.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.data IS 'Section data';


--
-- Name: COLUMN matrix_test.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_test.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_test.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_test.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_test.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_test.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_test.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_test.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_test.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_test.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_test.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_time_machine; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_time_machine (
    id integer NOT NULL,
    bulk_process_id integer,
    section_id integer,
    section_tipo character varying,
    tipo character varying,
    lang character varying,
    "timestamp" timestamp without time zone,
    user_id character varying(8),
    bulk_process_temp integer,
    data jsonb,
    tm_role smallint
);


--
-- Name: TABLE matrix_time_machine; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_time_machine IS 'Time Machine';


--
-- Name: COLUMN matrix_time_machine.bulk_process_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_time_machine.bulk_process_id IS 'Bulk process id identifying the massive change';


--
-- Name: COLUMN matrix_time_machine.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_time_machine.section_id IS 'section_id when the change was made';


--
-- Name: COLUMN matrix_time_machine.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_time_machine.section_tipo IS 'section_tipo when the change was made';


--
-- Name: COLUMN matrix_time_machine.tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_time_machine.tipo IS 'component tipo or section tipo when the change was made';


--
-- Name: COLUMN matrix_time_machine.lang; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_time_machine.lang IS 'component data lang of the change';


--
-- Name: COLUMN matrix_time_machine."timestamp"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_time_machine."timestamp" IS 'timestamp of the change';


--
-- Name: COLUMN matrix_time_machine.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_time_machine.user_id IS 'User section_id that made the change';


--
-- Name: COLUMN matrix_time_machine.bulk_process_temp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_time_machine.bulk_process_temp IS 'Bulk process id that identify a bulk change - copy';


--
-- Name: COLUMN matrix_time_machine.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_time_machine.data IS 'JSONB data representing the change';


--
-- Name: matrix_time_machine_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_time_machine_id_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_time_machine_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matrix_time_machine_id_seq OWNED BY public.matrix_time_machine.id;


--
-- Name: matrix_tools_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_tools_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_tools (
    id integer DEFAULT nextval('public.matrix_tools_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_tools; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_tools IS 'Tools register and development table';


--
-- Name: COLUMN matrix_tools.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_tools.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_tools.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_tools.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.data IS 'Section data';


--
-- Name: COLUMN matrix_tools.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_tools.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_tools.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_tools.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_tools.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_tools.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_tools.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_tools.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_tools.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_tools.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_tools.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: matrix_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_updates (
    id integer NOT NULL,
    data jsonb
);


--
-- Name: TABLE matrix_updates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_updates IS 'Data updates log table';


--
-- Name: COLUMN matrix_updates.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_updates.data IS 'Table data as a general JSON data';


--
-- Name: matrix_updates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_updates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_updates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matrix_updates_id_seq OWNED BY public.matrix_updates.id;


--
-- Name: matrix_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matrix_users_id_seq
    START WITH 1
    INCREMENT BY 1
    MINVALUE 0
    NO MAXVALUE
    CACHE 1;


--
-- Name: matrix_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matrix_users (
    id integer DEFAULT nextval('public.matrix_users_id_seq'::regclass) NOT NULL,
    section_id integer,
    section_tipo character varying,
    data jsonb,
    relation jsonb,
    string jsonb,
    date jsonb,
    iri jsonb,
    geo jsonb,
    number jsonb,
    media jsonb,
    misc jsonb,
    relation_search jsonb,
    meta jsonb
);


--
-- Name: TABLE matrix_users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.matrix_users IS 'Users table';


--
-- Name: COLUMN matrix_users.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.id IS 'Unique table identifier';


--
-- Name: COLUMN matrix_users.section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.section_id IS 'Section unique identifier';


--
-- Name: COLUMN matrix_users.section_tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';


--
-- Name: COLUMN matrix_users.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.data IS 'Section data';


--
-- Name: COLUMN matrix_users.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.relation IS 'Component data with relation values: dd151 | dd48 | dd47 | dd96 | dd98 | dd675';


--
-- Name: COLUMN matrix_users.string; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.string IS 'Component data with string values: dd750';


--
-- Name: COLUMN matrix_users.date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.date IS 'Component data with date values: dd1481';


--
-- Name: COLUMN matrix_users.iri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.iri IS 'Component data with IRI values: dd1562';


--
-- Name: COLUMN matrix_users.geo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.geo IS 'Component data with geolocation values: dd1564';


--
-- Name: COLUMN matrix_users.number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.number IS 'Component data with number values: dd1480';


--
-- Name: COLUMN matrix_users.media; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.media IS 'Component data with media values: dd1482';


--
-- Name: COLUMN matrix_users.misc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.misc IS 'Other component data with miscellaneous values: dd1474';


--
-- Name: COLUMN matrix_users.relation_search; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';


--
-- Name: COLUMN matrix_users.meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.matrix_users.meta IS 'Component metadata, used as counters for components and other value identifiers.';


--
-- Name: dd_ontology id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dd_ontology ALTER COLUMN id SET DEFAULT nextval('public.dd_ontology_id_seq'::regclass);


--
-- Name: main_dd id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.main_dd ALTER COLUMN id SET DEFAULT nextval('public.main_dd_id_seq'::regclass);


--
-- Name: matrix_activity_diffusion id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_activity_diffusion ALTER COLUMN id SET DEFAULT nextval('public.matrix_activity_diffusion_id_seq'::regclass);


--
-- Name: matrix_activity_diffusion section_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_activity_diffusion ALTER COLUMN section_id SET DEFAULT nextval('public.matrix_activity_diffusion_section_id_seq'::regclass);


--
-- Name: matrix_dd id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_dd ALTER COLUMN id SET DEFAULT nextval('public.matrix_dd_id_seq'::regclass);


--
-- Name: matrix_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_notifications ALTER COLUMN id SET DEFAULT nextval('public.matrix_notifications_id_seq'::regclass);


--
-- Name: matrix_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_profiles ALTER COLUMN id SET DEFAULT nextval('public.matrix_profiles_id_seq'::regclass);


--
-- Name: matrix_projects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_projects ALTER COLUMN id SET DEFAULT nextval('public.matrix_projects_id_seq'::regclass);


--
-- Name: matrix_time_machine id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_time_machine ALTER COLUMN id SET DEFAULT nextval('public.matrix_time_machine_id_seq'::regclass);


--
-- Name: matrix_updates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_updates ALTER COLUMN id SET DEFAULT nextval('public.matrix_updates_id_seq'::regclass);


--
-- Name: dd_ontology dd_ontology_alias_of_grammar; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.dd_ontology
    ADD CONSTRAINT dd_ontology_alias_of_grammar CHECK (((properties IS NULL) OR (jsonb_typeof(properties) <> 'object'::text) OR (NOT (properties ? 'alias_of'::text)) OR ((jsonb_typeof((properties -> 'alias_of'::text)) = 'string'::text) AND ((properties ->> 'alias_of'::text) ~ '^[a-z]+[0-9]+$'::text) AND (char_length((properties ->> 'alias_of'::text)) <= 32)))) NOT VALID;


--
-- Name: dd_ontology dd_ontology_id_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dd_ontology
    ADD CONSTRAINT dd_ontology_id_pkey PRIMARY KEY (id);


--
-- Name: dd_ontology dd_ontology_model_tipo_grammar; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.dd_ontology
    ADD CONSTRAINT dd_ontology_model_tipo_grammar CHECK (((model_tipo IS NULL) OR (((model_tipo)::text ~ '^[a-z]+[0-9]+$'::text) AND (char_length((model_tipo)::text) <= 8)))) NOT VALID;


--
-- Name: dd_ontology dd_ontology_parent_grammar; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.dd_ontology
    ADD CONSTRAINT dd_ontology_parent_grammar CHECK (((parent IS NULL) OR (((parent)::text ~ '^[a-z]+[0-9]+$'::text) AND (char_length((parent)::text) <= 32)))) NOT VALID;


--
-- Name: dd_ontology_recovery dd_ontology_recovery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dd_ontology_recovery
    ADD CONSTRAINT dd_ontology_recovery_pkey PRIMARY KEY (id);


--
-- Name: dd_ontology_recovery dd_ontology_recovery_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dd_ontology_recovery
    ADD CONSTRAINT dd_ontology_recovery_tipo_key UNIQUE (tipo);


--
-- Name: dd_ontology dd_ontology_tipo_grammar; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.dd_ontology
    ADD CONSTRAINT dd_ontology_tipo_grammar CHECK ((((tipo)::text ~ '^[a-z]+[0-9]+$'::text) AND (char_length((tipo)::text) <= 32))) NOT VALID;


--
-- Name: dd_ontology dd_ontology_tipo_in_tld; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.dd_ontology
    ADD CONSTRAINT dd_ontology_tipo_in_tld CHECK (((tld IS NULL) OR (NOT ("substring"((tipo)::text, '^[a-z]+'::text) IS DISTINCT FROM (tld)::text)))) NOT VALID;


--
-- Name: dd_ontology dd_ontology_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dd_ontology
    ADD CONSTRAINT dd_ontology_tipo_key UNIQUE (tipo);


--
-- Name: dd_ontology dd_ontology_tld_grammar; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.dd_ontology
    ADD CONSTRAINT dd_ontology_tld_grammar CHECK (((tld IS NULL) OR (((tld)::text ~ '^[a-z]{2,}$'::text) AND (char_length((tld)::text) <= 32)))) NOT VALID;


--
-- Name: main_dd main_dd_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.main_dd
    ADD CONSTRAINT main_dd_pkey PRIMARY KEY (id);


--
-- Name: matrix_activities matrix_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_activities
    ADD CONSTRAINT matrix_activities_pkey PRIMARY KEY (id);


--
-- Name: matrix_activities matrix_activities_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_activities
    ADD CONSTRAINT matrix_activities_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_activity_diffusion matrix_activity_diffusion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_activity_diffusion
    ADD CONSTRAINT matrix_activity_diffusion_pkey PRIMARY KEY (id);


--
-- Name: matrix_activity matrix_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_activity
    ADD CONSTRAINT matrix_activity_pkey PRIMARY KEY (id);


--
-- Name: matrix_activity matrix_activity_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_activity
    ADD CONSTRAINT matrix_activity_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_counter_dd matrix_counter_dd_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_counter_dd
    ADD CONSTRAINT matrix_counter_dd_tipo_key UNIQUE (tipo);


--
-- Name: matrix_counter matrix_counter_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_counter
    ADD CONSTRAINT matrix_counter_tipo_key UNIQUE (tipo);


--
-- Name: matrix_dataframe matrix_dataframe_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_dataframe
    ADD CONSTRAINT matrix_dataframe_pkey PRIMARY KEY (id);


--
-- Name: matrix_dataframe matrix_dataframe_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_dataframe
    ADD CONSTRAINT matrix_dataframe_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_dd matrix_dd_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_dd
    ADD CONSTRAINT matrix_dd_pkey PRIMARY KEY (id);


--
-- Name: matrix_dd matrix_dd_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_dd
    ADD CONSTRAINT matrix_dd_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_hierarchy_main matrix_hierarchy_main_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_hierarchy_main
    ADD CONSTRAINT matrix_hierarchy_main_pkey PRIMARY KEY (id);


--
-- Name: matrix_hierarchy_main matrix_hierarchy_main_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_hierarchy_main
    ADD CONSTRAINT matrix_hierarchy_main_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_hierarchy matrix_hierarchy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_hierarchy
    ADD CONSTRAINT matrix_hierarchy_pkey PRIMARY KEY (id);


--
-- Name: matrix_hierarchy matrix_hierarchy_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_hierarchy
    ADD CONSTRAINT matrix_hierarchy_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_indexations matrix_indexations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_indexations
    ADD CONSTRAINT matrix_indexations_pkey PRIMARY KEY (id);


--
-- Name: matrix_indexations matrix_indexations_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_indexations
    ADD CONSTRAINT matrix_indexations_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_langs matrix_langs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_langs
    ADD CONSTRAINT matrix_langs_pkey PRIMARY KEY (id);


--
-- Name: matrix_langs matrix_langs_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_langs
    ADD CONSTRAINT matrix_langs_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_layout_dd matrix_layout_dd_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_layout_dd
    ADD CONSTRAINT matrix_layout_dd_pkey PRIMARY KEY (id);


--
-- Name: matrix_layout_dd matrix_layout_dd_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_layout_dd
    ADD CONSTRAINT matrix_layout_dd_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_layout matrix_layout_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_layout
    ADD CONSTRAINT matrix_layout_pkey PRIMARY KEY (id);


--
-- Name: matrix_layout matrix_layout_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_layout
    ADD CONSTRAINT matrix_layout_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_list matrix_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_list
    ADD CONSTRAINT matrix_list_pkey PRIMARY KEY (id);


--
-- Name: matrix_list matrix_list_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_list
    ADD CONSTRAINT matrix_list_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_nexus_main matrix_nexus_main_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_nexus_main
    ADD CONSTRAINT matrix_nexus_main_pkey PRIMARY KEY (id);


--
-- Name: matrix_nexus_main matrix_nexus_main_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_nexus_main
    ADD CONSTRAINT matrix_nexus_main_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_nexus matrix_nexus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_nexus
    ADD CONSTRAINT matrix_nexus_pkey PRIMARY KEY (id);


--
-- Name: matrix_nexus matrix_nexus_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_nexus
    ADD CONSTRAINT matrix_nexus_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_notes matrix_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_notes
    ADD CONSTRAINT matrix_notes_pkey PRIMARY KEY (id);


--
-- Name: matrix_notes matrix_notes_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_notes
    ADD CONSTRAINT matrix_notes_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_notifications matrix_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_notifications
    ADD CONSTRAINT matrix_notifications_pkey PRIMARY KEY (id);


--
-- Name: matrix_ontology_main matrix_ontology_main_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_ontology_main
    ADD CONSTRAINT matrix_ontology_main_pkey PRIMARY KEY (id);


--
-- Name: matrix_ontology_main matrix_ontology_main_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_ontology_main
    ADD CONSTRAINT matrix_ontology_main_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_ontology matrix_ontology_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_ontology
    ADD CONSTRAINT matrix_ontology_pkey PRIMARY KEY (id);


--
-- Name: matrix_ontology matrix_ontology_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_ontology
    ADD CONSTRAINT matrix_ontology_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix matrix_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix
    ADD CONSTRAINT matrix_pkey PRIMARY KEY (id);


--
-- Name: matrix_profiles matrix_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_profiles
    ADD CONSTRAINT matrix_profiles_pkey PRIMARY KEY (id);


--
-- Name: matrix_profiles matrix_profiles_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_profiles
    ADD CONSTRAINT matrix_profiles_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_projects matrix_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_projects
    ADD CONSTRAINT matrix_projects_pkey PRIMARY KEY (id);


--
-- Name: matrix_projects matrix_projects_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_projects
    ADD CONSTRAINT matrix_projects_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix matrix_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix
    ADD CONSTRAINT matrix_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_stats matrix_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_stats
    ADD CONSTRAINT matrix_stats_pkey PRIMARY KEY (id);


--
-- Name: matrix_stats matrix_stats_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_stats
    ADD CONSTRAINT matrix_stats_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_test matrix_test_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_test
    ADD CONSTRAINT matrix_test_pkey PRIMARY KEY (id);


--
-- Name: matrix_test matrix_test_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_test
    ADD CONSTRAINT matrix_test_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_time_machine matrix_time_machine_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_time_machine
    ADD CONSTRAINT matrix_time_machine_pkey PRIMARY KEY (id);


--
-- Name: matrix_time_machine matrix_time_machine_tm_role_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.matrix_time_machine
    ADD CONSTRAINT matrix_time_machine_tm_role_check CHECK (((tm_role IS NULL) OR (tm_role = ANY (ARRAY[1, 3, 4])))) NOT VALID;


--
-- Name: matrix_tools matrix_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_tools
    ADD CONSTRAINT matrix_tools_pkey PRIMARY KEY (id);


--
-- Name: matrix_tools matrix_tools_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_tools
    ADD CONSTRAINT matrix_tools_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: matrix_updates matrix_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_updates
    ADD CONSTRAINT matrix_updates_pkey PRIMARY KEY (id);


--
-- Name: matrix_users matrix_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_users
    ADD CONSTRAINT matrix_users_pkey PRIMARY KEY (id);


--
-- Name: matrix_users matrix_users_section_id_section_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matrix_users
    ADD CONSTRAINT matrix_users_section_id_section_tipo_key UNIQUE (section_id, section_tipo);


--
-- Name: main_dd tld; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.main_dd
    ADD CONSTRAINT tld UNIQUE (tld);


--
-- Name: dd_ontology_is_main_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_is_main_idx ON public.dd_ontology USING btree (is_main);


--
-- Name: dd_ontology_is_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_is_model_idx ON public.dd_ontology USING btree (is_model);


--
-- Name: dd_ontology_is_translatable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_is_translatable_idx ON public.dd_ontology USING btree (is_translatable);


--
-- Name: dd_ontology_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_model_idx ON public.dd_ontology USING btree (model);


--
-- Name: dd_ontology_model_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_model_tipo_idx ON public.dd_ontology USING btree (model_tipo);


--
-- Name: dd_ontology_order_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_order_number_idx ON public.dd_ontology USING btree (order_number);


--
-- Name: dd_ontology_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_parent_idx ON public.dd_ontology USING btree (parent);


--
-- Name: dd_ontology_parent_order_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_parent_order_number_idx ON public.dd_ontology USING btree (parent, order_number);


--
-- Name: dd_ontology_relations_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_relations_idx ON public.dd_ontology USING gin (relations);


--
-- Name: dd_ontology_term_jsonpath_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_term_jsonpath_idx ON public.dd_ontology USING gin (term jsonb_path_ops);


--
-- Name: dd_ontology_term_trgm_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_term_trgm_values_idx ON public.dd_ontology USING gin (public.jsonb_values_as_text(term) public.gin_trgm_ops);


--
-- Name: dd_ontology_tld_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dd_ontology_tld_idx ON public.dd_ontology USING btree (tld);


--
-- Name: main_dd_tld_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX main_dd_tld_idx ON public.main_dd USING btree (tld);


--
-- Name: matrix_activities_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_date_gin_idx ON public.matrix_activities USING gin (date jsonb_path_ops);


--
-- Name: matrix_activities_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_geo_gin_idx ON public.matrix_activities USING gin (geo jsonb_path_ops);


--
-- Name: matrix_activities_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_iri_gin_idx ON public.matrix_activities USING gin (iri jsonb_path_ops);


--
-- Name: matrix_activities_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_media_gin_idx ON public.matrix_activities USING gin (media jsonb_path_ops);


--
-- Name: matrix_activities_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_misc_gin_idx ON public.matrix_activities USING gin (misc jsonb_path_ops);


--
-- Name: matrix_activities_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_number_gin_idx ON public.matrix_activities USING gin (number jsonb_path_ops);


--
-- Name: matrix_activities_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_relation_gin_idx ON public.matrix_activities USING gin (relation jsonb_path_ops);


--
-- Name: matrix_activities_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_relation_search_gin_idx ON public.matrix_activities USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_activities_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_section_id_idx ON public.matrix_activities USING btree (section_id);


--
-- Name: matrix_activities_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_section_tipo_idx ON public.matrix_activities USING btree (section_tipo);


--
-- Name: matrix_activities_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_section_tipo_section_id_desc_idx ON public.matrix_activities USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_activities_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activities_string_gin_idx ON public.matrix_activities USING gin (string jsonb_path_ops);


--
-- Name: matrix_activity_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_date_gin_idx ON public.matrix_activity USING gin (date jsonb_path_ops);


--
-- Name: matrix_activity_diffusion_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_diffusion_date_gin_idx ON public.matrix_activity_diffusion USING gin (date jsonb_path_ops);


--
-- Name: matrix_activity_diffusion_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_diffusion_number_gin_idx ON public.matrix_activity_diffusion USING gin (number jsonb_path_ops);


--
-- Name: matrix_activity_diffusion_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_diffusion_relation_gin_idx ON public.matrix_activity_diffusion USING gin (relation jsonb_path_ops);


--
-- Name: matrix_activity_diffusion_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_diffusion_section_tipo_section_id_desc_idx ON public.matrix_activity_diffusion USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_activity_diffusion_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_diffusion_string_gin_idx ON public.matrix_activity_diffusion USING gin (string jsonb_path_ops);


--
-- Name: matrix_activity_diffusion_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_diffusion_timestamp_idx ON public.matrix_activity_diffusion USING btree ("timestamp");


--
-- Name: matrix_activity_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_geo_gin_idx ON public.matrix_activity USING gin (geo jsonb_path_ops);


--
-- Name: matrix_activity_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_iri_gin_idx ON public.matrix_activity USING gin (iri jsonb_path_ops);


--
-- Name: matrix_activity_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_misc_gin_idx ON public.matrix_activity USING gin (misc jsonb_path_ops);


--
-- Name: matrix_activity_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_number_gin_idx ON public.matrix_activity USING gin (number jsonb_path_ops);


--
-- Name: matrix_activity_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_relation_gin_idx ON public.matrix_activity USING gin (relation jsonb_path_ops);


--
-- Name: matrix_activity_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_relation_search_gin_idx ON public.matrix_activity USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_activity_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_section_tipo_section_id_desc_idx ON public.matrix_activity USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_activity_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_string_gin_idx ON public.matrix_activity USING gin (string jsonb_path_ops);


--
-- Name: matrix_activity_timestamp_composite_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_timestamp_composite_idx ON public.matrix_activity USING btree ("timestamp", id) INCLUDE (section_tipo, section_id);


--
-- Name: matrix_activity_timestamp_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_timestamp_date_idx ON public.matrix_activity USING brin (date("timestamp"));


--
-- Name: matrix_activity_who_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_activity_who_ts_idx ON public.matrix_activity USING btree (((((relation -> 'dd543'::text) -> 0) ->> 'section_id'::text)), ((((relation -> 'dd543'::text) -> 0) ->> 'section_tipo'::text)), "timestamp" DESC, id DESC);


--
-- Name: matrix_dataframe_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_date_gin_idx ON public.matrix_dataframe USING gin (date jsonb_path_ops);


--
-- Name: matrix_dataframe_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_geo_gin_idx ON public.matrix_dataframe USING gin (geo jsonb_path_ops);


--
-- Name: matrix_dataframe_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_iri_gin_idx ON public.matrix_dataframe USING gin (iri jsonb_path_ops);


--
-- Name: matrix_dataframe_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_media_gin_idx ON public.matrix_dataframe USING gin (media jsonb_path_ops);


--
-- Name: matrix_dataframe_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_misc_gin_idx ON public.matrix_dataframe USING gin (misc jsonb_path_ops);


--
-- Name: matrix_dataframe_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_number_gin_idx ON public.matrix_dataframe USING gin (number jsonb_path_ops);


--
-- Name: matrix_dataframe_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_relation_gin_idx ON public.matrix_dataframe USING gin (relation jsonb_path_ops);


--
-- Name: matrix_dataframe_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_relation_search_gin_idx ON public.matrix_dataframe USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_dataframe_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_section_id_idx ON public.matrix_dataframe USING btree (section_id);


--
-- Name: matrix_dataframe_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_section_tipo_idx ON public.matrix_dataframe USING btree (section_tipo);


--
-- Name: matrix_dataframe_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_section_tipo_section_id_desc_idx ON public.matrix_dataframe USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_dataframe_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dataframe_string_gin_idx ON public.matrix_dataframe USING gin (string jsonb_path_ops);


--
-- Name: matrix_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_date_gin_idx ON public.matrix USING gin (date jsonb_path_ops);


--
-- Name: matrix_dd_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_date_gin_idx ON public.matrix_dd USING gin (date jsonb_path_ops);


--
-- Name: matrix_dd_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_geo_gin_idx ON public.matrix_dd USING gin (geo jsonb_path_ops);


--
-- Name: matrix_dd_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_iri_gin_idx ON public.matrix_dd USING gin (iri jsonb_path_ops);


--
-- Name: matrix_dd_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_media_gin_idx ON public.matrix_dd USING gin (media jsonb_path_ops);


--
-- Name: matrix_dd_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_misc_gin_idx ON public.matrix_dd USING gin (misc jsonb_path_ops);


--
-- Name: matrix_dd_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_number_gin_idx ON public.matrix_dd USING gin (number jsonb_path_ops);


--
-- Name: matrix_dd_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_relation_gin_idx ON public.matrix_dd USING gin (relation jsonb_path_ops);


--
-- Name: matrix_dd_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_relation_search_gin_idx ON public.matrix_dd USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_dd_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_section_id_idx ON public.matrix_dd USING btree (section_id);


--
-- Name: matrix_dd_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_section_tipo_idx ON public.matrix_dd USING btree (section_tipo);


--
-- Name: matrix_dd_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_section_tipo_section_id_desc_idx ON public.matrix_dd USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_dd_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_dd_string_gin_idx ON public.matrix_dd USING gin (string jsonb_path_ops);


--
-- Name: matrix_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_geo_gin_idx ON public.matrix USING gin (geo jsonb_path_ops);


--
-- Name: matrix_hierarchy_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_date_gin_idx ON public.matrix_hierarchy USING gin (date jsonb_path_ops);


--
-- Name: matrix_hierarchy_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_geo_gin_idx ON public.matrix_hierarchy USING gin (geo jsonb_path_ops);


--
-- Name: matrix_hierarchy_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_iri_gin_idx ON public.matrix_hierarchy USING gin (iri jsonb_path_ops);


--
-- Name: matrix_hierarchy_main_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_date_gin_idx ON public.matrix_hierarchy_main USING gin (date jsonb_path_ops);


--
-- Name: matrix_hierarchy_main_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_geo_gin_idx ON public.matrix_hierarchy_main USING gin (geo jsonb_path_ops);


--
-- Name: matrix_hierarchy_main_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_iri_gin_idx ON public.matrix_hierarchy_main USING gin (iri jsonb_path_ops);


--
-- Name: matrix_hierarchy_main_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_media_gin_idx ON public.matrix_hierarchy_main USING gin (media jsonb_path_ops);


--
-- Name: matrix_hierarchy_main_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_misc_gin_idx ON public.matrix_hierarchy_main USING gin (misc jsonb_path_ops);


--
-- Name: matrix_hierarchy_main_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_number_gin_idx ON public.matrix_hierarchy_main USING gin (number jsonb_path_ops);


--
-- Name: matrix_hierarchy_main_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_relation_gin_idx ON public.matrix_hierarchy_main USING gin (relation jsonb_path_ops);


--
-- Name: matrix_hierarchy_main_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_relation_search_gin_idx ON public.matrix_hierarchy_main USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_hierarchy_main_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_section_id_idx ON public.matrix_hierarchy_main USING btree (section_id);


--
-- Name: matrix_hierarchy_main_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_section_tipo_idx ON public.matrix_hierarchy_main USING btree (section_tipo);


--
-- Name: matrix_hierarchy_main_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_section_tipo_section_id_desc_idx ON public.matrix_hierarchy_main USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_hierarchy_main_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_main_string_gin_idx ON public.matrix_hierarchy_main USING gin (string jsonb_path_ops);


--
-- Name: matrix_hierarchy_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_media_gin_idx ON public.matrix_hierarchy USING gin (media jsonb_path_ops);


--
-- Name: matrix_hierarchy_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_misc_gin_idx ON public.matrix_hierarchy USING gin (misc jsonb_path_ops);


--
-- Name: matrix_hierarchy_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_number_gin_idx ON public.matrix_hierarchy USING gin (number jsonb_path_ops);


--
-- Name: matrix_hierarchy_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_relation_gin_idx ON public.matrix_hierarchy USING gin (relation jsonb_path_ops);


--
-- Name: matrix_hierarchy_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_relation_search_gin_idx ON public.matrix_hierarchy USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_hierarchy_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_section_id_idx ON public.matrix_hierarchy USING btree (section_id);


--
-- Name: matrix_hierarchy_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_section_tipo_idx ON public.matrix_hierarchy USING btree (section_tipo);


--
-- Name: matrix_hierarchy_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_section_tipo_section_id_desc_idx ON public.matrix_hierarchy USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_hierarchy_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_hierarchy_string_gin_idx ON public.matrix_hierarchy USING gin (string jsonb_path_ops);


--
-- Name: matrix_indexations_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_date_gin_idx ON public.matrix_indexations USING gin (date jsonb_path_ops);


--
-- Name: matrix_indexations_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_geo_gin_idx ON public.matrix_indexations USING gin (geo jsonb_path_ops);


--
-- Name: matrix_indexations_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_iri_gin_idx ON public.matrix_indexations USING gin (iri jsonb_path_ops);


--
-- Name: matrix_indexations_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_media_gin_idx ON public.matrix_indexations USING gin (media jsonb_path_ops);


--
-- Name: matrix_indexations_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_misc_gin_idx ON public.matrix_indexations USING gin (misc jsonb_path_ops);


--
-- Name: matrix_indexations_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_number_gin_idx ON public.matrix_indexations USING gin (number jsonb_path_ops);


--
-- Name: matrix_indexations_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_relation_gin_idx ON public.matrix_indexations USING gin (relation jsonb_path_ops);


--
-- Name: matrix_indexations_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_relation_search_gin_idx ON public.matrix_indexations USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_indexations_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_section_id_idx ON public.matrix_indexations USING btree (section_id);


--
-- Name: matrix_indexations_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_section_tipo_idx ON public.matrix_indexations USING btree (section_tipo);


--
-- Name: matrix_indexations_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_section_tipo_section_id_desc_idx ON public.matrix_indexations USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_indexations_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_indexations_string_gin_idx ON public.matrix_indexations USING gin (string jsonb_path_ops);


--
-- Name: matrix_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_iri_gin_idx ON public.matrix USING gin (iri jsonb_path_ops);


--
-- Name: matrix_langs_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_date_gin_idx ON public.matrix_langs USING gin (date jsonb_path_ops);


--
-- Name: matrix_langs_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_geo_gin_idx ON public.matrix_langs USING gin (geo jsonb_path_ops);


--
-- Name: matrix_langs_hierarchy41_value_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_hierarchy41_value_idx ON public.matrix_langs USING btree (((((string -> 'hierarchy41'::text) -> 0) ->> 'value'::text)));


--
-- Name: matrix_langs_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_iri_gin_idx ON public.matrix_langs USING gin (iri jsonb_path_ops);


--
-- Name: matrix_langs_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_media_gin_idx ON public.matrix_langs USING gin (media jsonb_path_ops);


--
-- Name: matrix_langs_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_misc_gin_idx ON public.matrix_langs USING gin (misc jsonb_path_ops);


--
-- Name: matrix_langs_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_number_gin_idx ON public.matrix_langs USING gin (number jsonb_path_ops);


--
-- Name: matrix_langs_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_relation_gin_idx ON public.matrix_langs USING gin (relation jsonb_path_ops);


--
-- Name: matrix_langs_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_relation_search_gin_idx ON public.matrix_langs USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_langs_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_section_id_idx ON public.matrix_langs USING btree (section_id);


--
-- Name: matrix_langs_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_section_tipo_idx ON public.matrix_langs USING btree (section_tipo);


--
-- Name: matrix_langs_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_section_tipo_section_id_desc_idx ON public.matrix_langs USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_langs_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_langs_string_gin_idx ON public.matrix_langs USING gin (string jsonb_path_ops);


--
-- Name: matrix_layout_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_date_gin_idx ON public.matrix_layout USING gin (date jsonb_path_ops);


--
-- Name: matrix_layout_dd_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_date_gin_idx ON public.matrix_layout_dd USING gin (date jsonb_path_ops);


--
-- Name: matrix_layout_dd_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_geo_gin_idx ON public.matrix_layout_dd USING gin (geo jsonb_path_ops);


--
-- Name: matrix_layout_dd_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_iri_gin_idx ON public.matrix_layout_dd USING gin (iri jsonb_path_ops);


--
-- Name: matrix_layout_dd_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_media_gin_idx ON public.matrix_layout_dd USING gin (media jsonb_path_ops);


--
-- Name: matrix_layout_dd_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_misc_gin_idx ON public.matrix_layout_dd USING gin (misc jsonb_path_ops);


--
-- Name: matrix_layout_dd_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_number_gin_idx ON public.matrix_layout_dd USING gin (number jsonb_path_ops);


--
-- Name: matrix_layout_dd_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_relation_gin_idx ON public.matrix_layout_dd USING gin (relation jsonb_path_ops);


--
-- Name: matrix_layout_dd_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_relation_search_gin_idx ON public.matrix_layout_dd USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_layout_dd_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_section_id_idx ON public.matrix_layout_dd USING btree (section_id);


--
-- Name: matrix_layout_dd_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_section_tipo_idx ON public.matrix_layout_dd USING btree (section_tipo);


--
-- Name: matrix_layout_dd_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_section_tipo_section_id_desc_idx ON public.matrix_layout_dd USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_layout_dd_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_dd_string_gin_idx ON public.matrix_layout_dd USING gin (string jsonb_path_ops);


--
-- Name: matrix_layout_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_geo_gin_idx ON public.matrix_layout USING gin (geo jsonb_path_ops);


--
-- Name: matrix_layout_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_iri_gin_idx ON public.matrix_layout USING gin (iri jsonb_path_ops);


--
-- Name: matrix_layout_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_media_gin_idx ON public.matrix_layout USING gin (media jsonb_path_ops);


--
-- Name: matrix_layout_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_misc_gin_idx ON public.matrix_layout USING gin (misc jsonb_path_ops);


--
-- Name: matrix_layout_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_number_gin_idx ON public.matrix_layout USING gin (number jsonb_path_ops);


--
-- Name: matrix_layout_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_relation_gin_idx ON public.matrix_layout USING gin (relation jsonb_path_ops);


--
-- Name: matrix_layout_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_relation_search_gin_idx ON public.matrix_layout USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_layout_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_section_id_idx ON public.matrix_layout USING btree (section_id);


--
-- Name: matrix_layout_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_section_tipo_idx ON public.matrix_layout USING btree (section_tipo);


--
-- Name: matrix_layout_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_section_tipo_section_id_desc_idx ON public.matrix_layout USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_layout_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_layout_string_gin_idx ON public.matrix_layout USING gin (string jsonb_path_ops);


--
-- Name: matrix_list_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_date_gin_idx ON public.matrix_list USING gin (date jsonb_path_ops);


--
-- Name: matrix_list_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_geo_gin_idx ON public.matrix_list USING gin (geo jsonb_path_ops);


--
-- Name: matrix_list_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_iri_gin_idx ON public.matrix_list USING gin (iri jsonb_path_ops);


--
-- Name: matrix_list_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_media_gin_idx ON public.matrix_list USING gin (media jsonb_path_ops);


--
-- Name: matrix_list_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_misc_gin_idx ON public.matrix_list USING gin (misc jsonb_path_ops);


--
-- Name: matrix_list_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_number_gin_idx ON public.matrix_list USING gin (number jsonb_path_ops);


--
-- Name: matrix_list_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_relation_gin_idx ON public.matrix_list USING gin (relation jsonb_path_ops);


--
-- Name: matrix_list_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_relation_search_gin_idx ON public.matrix_list USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_list_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_section_id_idx ON public.matrix_list USING btree (section_id);


--
-- Name: matrix_list_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_section_tipo_idx ON public.matrix_list USING btree (section_tipo);


--
-- Name: matrix_list_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_section_tipo_section_id_desc_idx ON public.matrix_list USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_list_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_list_string_gin_idx ON public.matrix_list USING gin (string jsonb_path_ops);


--
-- Name: matrix_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_media_gin_idx ON public.matrix USING gin (media jsonb_path_ops);


--
-- Name: matrix_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_misc_gin_idx ON public.matrix USING gin (misc jsonb_path_ops);


--
-- Name: matrix_nexus_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_date_gin_idx ON public.matrix_nexus USING gin (date jsonb_path_ops);


--
-- Name: matrix_nexus_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_geo_gin_idx ON public.matrix_nexus USING gin (geo jsonb_path_ops);


--
-- Name: matrix_nexus_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_iri_gin_idx ON public.matrix_nexus USING gin (iri jsonb_path_ops);


--
-- Name: matrix_nexus_main_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_date_gin_idx ON public.matrix_nexus_main USING gin (date jsonb_path_ops);


--
-- Name: matrix_nexus_main_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_geo_gin_idx ON public.matrix_nexus_main USING gin (geo jsonb_path_ops);


--
-- Name: matrix_nexus_main_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_iri_gin_idx ON public.matrix_nexus_main USING gin (iri jsonb_path_ops);


--
-- Name: matrix_nexus_main_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_media_gin_idx ON public.matrix_nexus_main USING gin (media jsonb_path_ops);


--
-- Name: matrix_nexus_main_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_misc_gin_idx ON public.matrix_nexus_main USING gin (misc jsonb_path_ops);


--
-- Name: matrix_nexus_main_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_number_gin_idx ON public.matrix_nexus_main USING gin (number jsonb_path_ops);


--
-- Name: matrix_nexus_main_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_relation_gin_idx ON public.matrix_nexus_main USING gin (relation jsonb_path_ops);


--
-- Name: matrix_nexus_main_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_relation_search_gin_idx ON public.matrix_nexus_main USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_nexus_main_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_section_id_idx ON public.matrix_nexus_main USING btree (section_id);


--
-- Name: matrix_nexus_main_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_section_tipo_idx ON public.matrix_nexus_main USING btree (section_tipo);


--
-- Name: matrix_nexus_main_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_section_tipo_section_id_desc_idx ON public.matrix_nexus_main USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_nexus_main_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_main_string_gin_idx ON public.matrix_nexus_main USING gin (string jsonb_path_ops);


--
-- Name: matrix_nexus_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_media_gin_idx ON public.matrix_nexus USING gin (media jsonb_path_ops);


--
-- Name: matrix_nexus_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_misc_gin_idx ON public.matrix_nexus USING gin (misc jsonb_path_ops);


--
-- Name: matrix_nexus_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_number_gin_idx ON public.matrix_nexus USING gin (number jsonb_path_ops);


--
-- Name: matrix_nexus_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_relation_gin_idx ON public.matrix_nexus USING gin (relation jsonb_path_ops);


--
-- Name: matrix_nexus_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_relation_search_gin_idx ON public.matrix_nexus USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_nexus_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_section_id_idx ON public.matrix_nexus USING btree (section_id);


--
-- Name: matrix_nexus_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_section_tipo_idx ON public.matrix_nexus USING btree (section_tipo);


--
-- Name: matrix_nexus_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_section_tipo_section_id_desc_idx ON public.matrix_nexus USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_nexus_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_nexus_string_gin_idx ON public.matrix_nexus USING gin (string jsonb_path_ops);


--
-- Name: matrix_notes_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_date_gin_idx ON public.matrix_notes USING gin (date jsonb_path_ops);


--
-- Name: matrix_notes_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_geo_gin_idx ON public.matrix_notes USING gin (geo jsonb_path_ops);


--
-- Name: matrix_notes_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_iri_gin_idx ON public.matrix_notes USING gin (iri jsonb_path_ops);


--
-- Name: matrix_notes_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_media_gin_idx ON public.matrix_notes USING gin (media jsonb_path_ops);


--
-- Name: matrix_notes_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_misc_gin_idx ON public.matrix_notes USING gin (misc jsonb_path_ops);


--
-- Name: matrix_notes_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_number_gin_idx ON public.matrix_notes USING gin (number jsonb_path_ops);


--
-- Name: matrix_notes_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_relation_gin_idx ON public.matrix_notes USING gin (relation jsonb_path_ops);


--
-- Name: matrix_notes_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_relation_search_gin_idx ON public.matrix_notes USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_notes_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_section_id_idx ON public.matrix_notes USING btree (section_id);


--
-- Name: matrix_notes_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_section_tipo_idx ON public.matrix_notes USING btree (section_tipo);


--
-- Name: matrix_notes_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_section_tipo_section_id_desc_idx ON public.matrix_notes USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_notes_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_notes_string_gin_idx ON public.matrix_notes USING gin (string jsonb_path_ops);


--
-- Name: matrix_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_number_gin_idx ON public.matrix USING gin (number jsonb_path_ops);


--
-- Name: matrix_ontology_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_date_gin_idx ON public.matrix_ontology USING gin (date jsonb_path_ops);


--
-- Name: matrix_ontology_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_geo_gin_idx ON public.matrix_ontology USING gin (geo jsonb_path_ops);


--
-- Name: matrix_ontology_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_iri_gin_idx ON public.matrix_ontology USING gin (iri jsonb_path_ops);


--
-- Name: matrix_ontology_main_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_date_gin_idx ON public.matrix_ontology_main USING gin (date jsonb_path_ops);


--
-- Name: matrix_ontology_main_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_geo_gin_idx ON public.matrix_ontology_main USING gin (geo jsonb_path_ops);


--
-- Name: matrix_ontology_main_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_iri_gin_idx ON public.matrix_ontology_main USING gin (iri jsonb_path_ops);


--
-- Name: matrix_ontology_main_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_media_gin_idx ON public.matrix_ontology_main USING gin (media jsonb_path_ops);


--
-- Name: matrix_ontology_main_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_misc_gin_idx ON public.matrix_ontology_main USING gin (misc jsonb_path_ops);


--
-- Name: matrix_ontology_main_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_number_gin_idx ON public.matrix_ontology_main USING gin (number jsonb_path_ops);


--
-- Name: matrix_ontology_main_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_relation_gin_idx ON public.matrix_ontology_main USING gin (relation jsonb_path_ops);


--
-- Name: matrix_ontology_main_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_relation_search_gin_idx ON public.matrix_ontology_main USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_ontology_main_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_section_id_idx ON public.matrix_ontology_main USING btree (section_id);


--
-- Name: matrix_ontology_main_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_section_tipo_idx ON public.matrix_ontology_main USING btree (section_tipo);


--
-- Name: matrix_ontology_main_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_section_tipo_section_id_desc_idx ON public.matrix_ontology_main USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_ontology_main_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_main_string_gin_idx ON public.matrix_ontology_main USING gin (string jsonb_path_ops);


--
-- Name: matrix_ontology_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_media_gin_idx ON public.matrix_ontology USING gin (media jsonb_path_ops);


--
-- Name: matrix_ontology_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_misc_gin_idx ON public.matrix_ontology USING gin (misc jsonb_path_ops);


--
-- Name: matrix_ontology_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_number_gin_idx ON public.matrix_ontology USING gin (number jsonb_path_ops);


--
-- Name: matrix_ontology_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_relation_gin_idx ON public.matrix_ontology USING gin (relation jsonb_path_ops);


--
-- Name: matrix_ontology_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_relation_search_gin_idx ON public.matrix_ontology USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_ontology_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_section_id_idx ON public.matrix_ontology USING btree (section_id);


--
-- Name: matrix_ontology_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_section_tipo_idx ON public.matrix_ontology USING btree (section_tipo);


--
-- Name: matrix_ontology_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_section_tipo_section_id_desc_idx ON public.matrix_ontology USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_ontology_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_ontology_string_gin_idx ON public.matrix_ontology USING gin (string jsonb_path_ops);


--
-- Name: matrix_profiles_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_date_gin_idx ON public.matrix_profiles USING gin (date jsonb_path_ops);


--
-- Name: matrix_profiles_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_geo_gin_idx ON public.matrix_profiles USING gin (geo jsonb_path_ops);


--
-- Name: matrix_profiles_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_iri_gin_idx ON public.matrix_profiles USING gin (iri jsonb_path_ops);


--
-- Name: matrix_profiles_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_media_gin_idx ON public.matrix_profiles USING gin (media jsonb_path_ops);


--
-- Name: matrix_profiles_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_misc_gin_idx ON public.matrix_profiles USING gin (misc jsonb_path_ops);


--
-- Name: matrix_profiles_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_number_gin_idx ON public.matrix_profiles USING gin (number jsonb_path_ops);


--
-- Name: matrix_profiles_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_relation_gin_idx ON public.matrix_profiles USING gin (relation jsonb_path_ops);


--
-- Name: matrix_profiles_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_relation_search_gin_idx ON public.matrix_profiles USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_profiles_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_section_id_idx ON public.matrix_profiles USING btree (section_id);


--
-- Name: matrix_profiles_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_section_tipo_idx ON public.matrix_profiles USING btree (section_tipo);


--
-- Name: matrix_profiles_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_section_tipo_section_id_desc_idx ON public.matrix_profiles USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_profiles_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_profiles_string_gin_idx ON public.matrix_profiles USING gin (string jsonb_path_ops);


--
-- Name: matrix_projects_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_date_gin_idx ON public.matrix_projects USING gin (date jsonb_path_ops);


--
-- Name: matrix_projects_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_geo_gin_idx ON public.matrix_projects USING gin (geo jsonb_path_ops);


--
-- Name: matrix_projects_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_iri_gin_idx ON public.matrix_projects USING gin (iri jsonb_path_ops);


--
-- Name: matrix_projects_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_media_gin_idx ON public.matrix_projects USING gin (media jsonb_path_ops);


--
-- Name: matrix_projects_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_misc_gin_idx ON public.matrix_projects USING gin (misc jsonb_path_ops);


--
-- Name: matrix_projects_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_number_gin_idx ON public.matrix_projects USING gin (number jsonb_path_ops);


--
-- Name: matrix_projects_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_relation_gin_idx ON public.matrix_projects USING gin (relation jsonb_path_ops);


--
-- Name: matrix_projects_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_relation_search_gin_idx ON public.matrix_projects USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_projects_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_section_id_idx ON public.matrix_projects USING btree (section_id);


--
-- Name: matrix_projects_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_section_tipo_idx ON public.matrix_projects USING btree (section_tipo);


--
-- Name: matrix_projects_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_section_tipo_section_id_desc_idx ON public.matrix_projects USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_projects_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_projects_string_gin_idx ON public.matrix_projects USING gin (string jsonb_path_ops);


--
-- Name: matrix_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_relation_gin_idx ON public.matrix USING gin (relation jsonb_path_ops);


--
-- Name: matrix_relation_index_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_relation_index_from_idx ON public.matrix_relation_index USING btree (section_tipo, section_id);


--
-- Name: matrix_relation_index_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_relation_index_target_idx ON public.matrix_relation_index USING btree (target_section_tipo, target_section_id, from_component_tipo);


--
-- Name: matrix_relation_index_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_relation_index_type_idx ON public.matrix_relation_index USING btree (type, target_section_tipo, target_section_id);


--
-- Name: matrix_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_relation_search_gin_idx ON public.matrix USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_section_id_idx ON public.matrix USING btree (section_id);


--
-- Name: matrix_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_section_tipo_idx ON public.matrix USING btree (section_tipo);


--
-- Name: matrix_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_section_tipo_section_id_desc_idx ON public.matrix USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_stats_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_date_gin_idx ON public.matrix_stats USING gin (date jsonb_path_ops);


--
-- Name: matrix_stats_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_geo_gin_idx ON public.matrix_stats USING gin (geo jsonb_path_ops);


--
-- Name: matrix_stats_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_iri_gin_idx ON public.matrix_stats USING gin (iri jsonb_path_ops);


--
-- Name: matrix_stats_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_media_gin_idx ON public.matrix_stats USING gin (media jsonb_path_ops);


--
-- Name: matrix_stats_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_misc_gin_idx ON public.matrix_stats USING gin (misc jsonb_path_ops);


--
-- Name: matrix_stats_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_number_gin_idx ON public.matrix_stats USING gin (number jsonb_path_ops);


--
-- Name: matrix_stats_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_relation_gin_idx ON public.matrix_stats USING gin (relation jsonb_path_ops);


--
-- Name: matrix_stats_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_relation_search_gin_idx ON public.matrix_stats USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_stats_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_section_id_idx ON public.matrix_stats USING btree (section_id);


--
-- Name: matrix_stats_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_section_tipo_idx ON public.matrix_stats USING btree (section_tipo);


--
-- Name: matrix_stats_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_section_tipo_section_id_desc_idx ON public.matrix_stats USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_stats_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_stats_string_gin_idx ON public.matrix_stats USING gin (string jsonb_path_ops);


--
-- Name: matrix_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_string_gin_idx ON public.matrix USING gin (string jsonb_path_ops);


--
-- Name: matrix_string_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_string_search_gin_idx ON public.matrix_string_search USING gin (component_tipo, string public.gin_trgm_ops);


--
-- Name: matrix_string_search_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_string_search_record_idx ON public.matrix_string_search USING btree (section_tipo, section_id);


--
-- Name: matrix_test_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_date_gin_idx ON public.matrix_test USING gin (date jsonb_path_ops);


--
-- Name: matrix_test_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_geo_gin_idx ON public.matrix_test USING gin (geo jsonb_path_ops);


--
-- Name: matrix_test_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_iri_gin_idx ON public.matrix_test USING gin (iri jsonb_path_ops);


--
-- Name: matrix_test_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_media_gin_idx ON public.matrix_test USING gin (media jsonb_path_ops);


--
-- Name: matrix_test_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_misc_gin_idx ON public.matrix_test USING gin (misc jsonb_path_ops);


--
-- Name: matrix_test_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_number_gin_idx ON public.matrix_test USING gin (number jsonb_path_ops);


--
-- Name: matrix_test_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_relation_gin_idx ON public.matrix_test USING gin (relation jsonb_path_ops);


--
-- Name: matrix_test_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_relation_search_gin_idx ON public.matrix_test USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_test_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_section_id_idx ON public.matrix_test USING btree (section_id);


--
-- Name: matrix_test_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_section_tipo_idx ON public.matrix_test USING btree (section_tipo);


--
-- Name: matrix_test_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_section_tipo_section_id_desc_idx ON public.matrix_test USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_test_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_test_string_gin_idx ON public.matrix_test USING gin (string jsonb_path_ops);


--
-- Name: matrix_time_machine_bulk_process_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_bulk_process_id_idx ON public.matrix_time_machine USING btree (bulk_process_id);


--
-- Name: matrix_time_machine_history_visible_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_history_visible_idx ON public.matrix_time_machine USING btree (section_tipo, section_id DESC, id DESC) WHERE (tm_role IS NULL);


--
-- Name: matrix_time_machine_lang_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_lang_idx ON public.matrix_time_machine USING btree (lang);


--
-- Name: matrix_time_machine_record_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_record_history_idx ON public.matrix_time_machine USING btree (section_tipo, section_id DESC, id DESC);


--
-- Name: matrix_time_machine_search_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_search_default_idx ON public.matrix_time_machine USING btree (section_id, section_tipo, tipo, lang, "timestamp" DESC);


--
-- Name: matrix_time_machine_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_section_id_idx ON public.matrix_time_machine USING btree (section_id);


--
-- Name: matrix_time_machine_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_section_tipo_idx ON public.matrix_time_machine USING btree (section_tipo, id DESC);


--
-- Name: matrix_time_machine_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_section_tipo_section_id_desc_idx ON public.matrix_time_machine USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_time_machine_si_bulk_st_tipo_lang_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_si_bulk_st_tipo_lang_idx ON public.matrix_time_machine USING btree (section_id, bulk_process_id, section_tipo, tipo, lang);


--
-- Name: matrix_time_machine_timestamp_date_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_timestamp_date_id_idx ON public.matrix_time_machine USING btree ("timestamp", id DESC);


--
-- Name: matrix_time_machine_timestamp_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_timestamp_date_idx ON public.matrix_time_machine USING brin (date("timestamp"));


--
-- Name: matrix_time_machine_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_tipo_idx ON public.matrix_time_machine USING btree (tipo, id DESC);


--
-- Name: matrix_time_machine_tm_role_hidden_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_tm_role_hidden_idx ON public.matrix_time_machine USING btree (section_tipo, section_id DESC, id DESC) WHERE (tm_role IS NOT NULL);


--
-- Name: matrix_time_machine_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_time_machine_user_id_idx ON public.matrix_time_machine USING btree (user_id);


--
-- Name: matrix_tools_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_date_gin_idx ON public.matrix_tools USING gin (date jsonb_path_ops);


--
-- Name: matrix_tools_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_geo_gin_idx ON public.matrix_tools USING gin (geo jsonb_path_ops);


--
-- Name: matrix_tools_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_iri_gin_idx ON public.matrix_tools USING gin (iri jsonb_path_ops);


--
-- Name: matrix_tools_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_media_gin_idx ON public.matrix_tools USING gin (media jsonb_path_ops);


--
-- Name: matrix_tools_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_misc_gin_idx ON public.matrix_tools USING gin (misc jsonb_path_ops);


--
-- Name: matrix_tools_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_number_gin_idx ON public.matrix_tools USING gin (number jsonb_path_ops);


--
-- Name: matrix_tools_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_relation_gin_idx ON public.matrix_tools USING gin (relation jsonb_path_ops);


--
-- Name: matrix_tools_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_relation_search_gin_idx ON public.matrix_tools USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_tools_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_section_id_idx ON public.matrix_tools USING btree (section_id);


--
-- Name: matrix_tools_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_section_tipo_idx ON public.matrix_tools USING btree (section_tipo);


--
-- Name: matrix_tools_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_section_tipo_section_id_desc_idx ON public.matrix_tools USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_tools_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_tools_string_gin_idx ON public.matrix_tools USING gin (string jsonb_path_ops);


--
-- Name: matrix_users_date_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_date_gin_idx ON public.matrix_users USING gin (date jsonb_path_ops);


--
-- Name: matrix_users_geo_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_geo_gin_idx ON public.matrix_users USING gin (geo jsonb_path_ops);


--
-- Name: matrix_users_iri_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_iri_gin_idx ON public.matrix_users USING gin (iri jsonb_path_ops);


--
-- Name: matrix_users_media_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_media_gin_idx ON public.matrix_users USING gin (media jsonb_path_ops);


--
-- Name: matrix_users_misc_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_misc_gin_idx ON public.matrix_users USING gin (misc jsonb_path_ops);


--
-- Name: matrix_users_number_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_number_gin_idx ON public.matrix_users USING gin (number jsonb_path_ops);


--
-- Name: matrix_users_relation_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_relation_gin_idx ON public.matrix_users USING gin (relation jsonb_path_ops);


--
-- Name: matrix_users_relation_search_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_relation_search_gin_idx ON public.matrix_users USING gin (relation_search jsonb_path_ops);


--
-- Name: matrix_users_section_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_section_id_idx ON public.matrix_users USING btree (section_id);


--
-- Name: matrix_users_section_tipo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_section_tipo_idx ON public.matrix_users USING btree (section_tipo);


--
-- Name: matrix_users_section_tipo_section_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_section_tipo_section_id_desc_idx ON public.matrix_users USING btree (section_tipo, section_id DESC);


--
-- Name: matrix_users_string_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matrix_users_string_gin_idx ON public.matrix_users USING gin (string jsonb_path_ops);


--
-- Name: matrix_activities matrix_activities_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_activities_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_activities FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_activities matrix_activities_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_activities_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_activities FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_dataframe matrix_dataframe_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_dataframe_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_dataframe FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_dataframe matrix_dataframe_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_dataframe_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_dataframe FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_dd matrix_dd_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_dd_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_dd FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_dd matrix_dd_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_dd_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_dd FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_hierarchy_main matrix_hierarchy_main_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_hierarchy_main_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_hierarchy_main FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_hierarchy_main matrix_hierarchy_main_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_hierarchy_main_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_hierarchy_main FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_hierarchy matrix_hierarchy_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_hierarchy_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_hierarchy FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_hierarchy matrix_hierarchy_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_hierarchy_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_hierarchy FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_indexations matrix_indexations_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_indexations_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_indexations FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_indexations matrix_indexations_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_indexations_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_indexations FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_langs matrix_langs_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_langs_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_langs FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_langs matrix_langs_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_langs_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_langs FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_layout_dd matrix_layout_dd_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_layout_dd_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_layout_dd FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_layout_dd matrix_layout_dd_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_layout_dd_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_layout_dd FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_layout matrix_layout_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_layout_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_layout FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_layout matrix_layout_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_layout_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_layout FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_list matrix_list_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_list_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_list FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_list matrix_list_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_list_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_list FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_nexus_main matrix_nexus_main_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_nexus_main_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_nexus_main FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_nexus_main matrix_nexus_main_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_nexus_main_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_nexus_main FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_nexus matrix_nexus_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_nexus_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_nexus FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_nexus matrix_nexus_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_nexus_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_nexus FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_notes matrix_notes_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_notes_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_notes FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_notes matrix_notes_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_notes_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_notes FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_ontology_main matrix_ontology_main_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_ontology_main_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_ontology_main FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_ontology_main matrix_ontology_main_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_ontology_main_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_ontology_main FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_ontology matrix_ontology_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_ontology_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_ontology FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_ontology matrix_ontology_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_ontology_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_ontology FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_profiles matrix_profiles_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_profiles_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_profiles FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_profiles matrix_profiles_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_profiles_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_profiles FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_projects matrix_projects_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_projects_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_projects FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_projects matrix_projects_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_projects_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_projects FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix matrix_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix matrix_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_test matrix_test_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_test_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_test FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_test matrix_test_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_test_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_test FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_tools matrix_tools_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_tools_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_tools FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_tools matrix_tools_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_tools_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_tools FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- Name: matrix_users matrix_users_relation_index_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_users_relation_index_sync AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON public.matrix_users FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();


--
-- Name: matrix_users matrix_users_string_search_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER matrix_users_string_search_sync AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON public.matrix_users FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();


--
-- PostgreSQL database dump complete
--


