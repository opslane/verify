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
-- Data for Name: Booking; Type: TABLE DATA; Schema: public; Owner: calcom
--

INSERT INTO public."Booking" VALUES (31, '10a0db90-2afd-40d3-b6d2-d9315ae863a5', 4, 9001, '30 Min Meeting', NULL, '2026-03-21 21:13:16.895', '2026-03-21 21:43:16.895', '2026-03-20 21:13:16.895', '2026-03-20 21:13:16.895', 'integrations:daily', false, 'accepted', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 0, '', NULL, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public."Booking" VALUES (32, '40f519f9-e8bf-4ff6-b851-830e1403517b', 4, 9001, '30 Min Meeting', NULL, '2026-03-22 21:13:16.895', '2026-03-22 21:43:16.895', '2026-03-20 21:13:16.895', '2026-03-20 21:13:16.895', 'integrations:daily', false, 'accepted', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 0, '', NULL, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);


--
-- Name: Booking_id_seq; Type: SEQUENCE SET; Schema: public; Owner: calcom
--

SELECT pg_catalog.setval('public."Booking_id_seq"', 32, true);


--
-- PostgreSQL database dump complete
--

