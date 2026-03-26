--
-- PostgreSQL database dump
--

-- Dumped from database version 16.9 (Homebrew)
-- Dumped by pg_dump version 16.9 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: Membership; Type: TABLE DATA; Schema: public; Owner: calcom
--

INSERT INTO public."Membership" VALUES (2, 9, true, 'OWNER', false, 148, '2026-03-19 15:58:36.332', NULL, 'owner_role');


--
-- Name: Membership_id_seq; Type: SEQUENCE SET; Schema: public; Owner: calcom
--

SELECT pg_catalog.setval('public."Membership_id_seq"', 148, true);


--
-- PostgreSQL database dump complete
--

