-- neo-api 의 db/migration/V1__create_geo.sql 을 그대로 미러링한 테스트 픽스처다.
-- Testcontainers 로 띄운 빈 Postgres 에 실제 스키마를 만들어, 엔티티(synchronize:false)가
-- 운영과 같은 테이블을 상대로 검증되게 하는 것이 목적이다.
--
-- 원천과 다른 점은 아래 두 가지뿐이며, 그 외에는 한 글자도 바꾸지 않는다.
-- 원천이 갱신되면 이 파일도 함께 갱신한다(APGEO-223 에서 dedup_key 만 고치고
-- product_sn·geo_result UNIQUE·channel_api_key·geo_delivery 를 놓쳐 드리프트가 발생했다).
--
--   1) `create schema neo` 를 여기서 만든다. 원천은 운영 DB 에 스키마가 사전 생성되어
--      있다고 보고 만들지 않지만, 빈 컨테이너에는 만들어 줄 주체가 없다.
--   2) 맨 끝에 TEST 채널 1건을 시드한다. test/utils/db.ts 가 channel_code='TEST' 로
--      channel_id 를 조회해 모든 int-spec 의 FK 값으로 쓴다.

create schema if not exists neo;

-- ===== 이하 원천(V1__create_geo.sql) 그대로 =====

-- NEO 초기 스키마. 기존 V1~V5 마이그레이션을 최종 상태 하나로 합친 파일이다
-- (중간 단계였던 channel.api_key_hash 컬럼과 그 이전(migration) 로직은 남기지 않는다).
-- 모든 객체는 neo 스키마에 명시적으로 생성한다.
-- neo 스키마 자체는 이 마이그레이션에서 만들지 않는다 — 대상 DB에 사전(수동/운영 단계)에 생성되어 있어야 한다.

-- 채널 레지스트리 (브랜드 쇼핑몰). 전송 대상 관리. 인증 키는 channel_api_key가 보유한다.
create table neo.channel (
    channel_id        bigserial primary key,
    channel_code      varchar(50)  not null unique,
    name              varchar(100) not null,
    status            varchar(20)  not null,
    delivery_url      varchar(500),
    delivery_auth_ref varchar(200),
    created_at        timestamptz  not null
);

comment on table neo.channel is '채널(브랜드 쇼핑몰) 레지스트리. API-KEY 인증과 GEO 전송 대상을 관리한다.';
comment on column neo.channel.channel_id is '채널 PK.';
comment on column neo.channel.channel_code is '채널 식별 코드(고유).';
comment on column neo.channel.name is '채널 표시명.';
comment on column neo.channel.status is '채널 상태: ACTIVE(접수 허용) / SUSPENDED(인증 거절).';
comment on column neo.channel.delivery_url is 'GEO 결과를 Push 전송할 채널 엔드포인트 URL.';
comment on column neo.channel.delivery_auth_ref is '전송 시 사용할 인증정보 참조 키(시크릿 저장소 등). 비밀값 원문 저장 금지.';
comment on column neo.channel.created_at is '생성 시각.';

-- 채널 API-KEY. 채널당 여러 키를 동시에 둘 수 있어 무중단 교체가 가능하다.
create table neo.channel_api_key (
    channel_api_key_id bigserial    primary key,
    channel_id         bigint       not null references neo.channel (channel_id),
    label              varchar(50)  not null,
    key_prefix         varchar(20),
    key_hash           varchar(64)  not null unique,
    expires_at         timestamptz,
    revoked_at         timestamptz,
    created_at         timestamptz  not null
);

create index idx_channel_api_key_channel on neo.channel_api_key (channel_id);

comment on table neo.channel_api_key is '채널 API-KEY 레지스트리. 한 채널이 여러 키를 동시에 보유할 수 있어 무중단 키 교체가 가능하다. 인증은 key_hash 단건 조회로 판정한다.';
comment on column neo.channel_api_key.channel_api_key_id is '키 PK.';
comment on column neo.channel_api_key.channel_id is '소유 채널 FK(channel.channel_id).';
comment on column neo.channel_api_key.label is '키를 사람이 식별하기 위한 이름(예: 2026-08 정기교체). 인증 판정에는 쓰지 않는다.';
comment on column neo.channel_api_key.key_prefix is 'API-KEY 원문 앞부분(neo_sk_ + 7자) 평문. 로그 마스킹·401 원인 추적·키 목록 대조용이며 인증 판정에는 쓰지 않는다.';
comment on column neo.channel_api_key.key_hash is 'API-KEY 원문의 SHA-256 hex. 원문은 저장하지 않는다. 인증 조회 키.';
comment on column neo.channel_api_key.expires_at is '만료 시각. 이 시각 이후 인증 거절. null은 무기한. 키 교체 시 구 키에 유예 기간을 주는 수단이다.';
comment on column neo.channel_api_key.revoked_at is '폐기 시각. 값이 있으면 즉시 인증 거절. 유출 사고 시 즉시 차단용.';
comment on column neo.channel_api_key.created_at is '발급 시각.';

-- GEO 생성 생애주기 (상태 머신). geo_generation_id = geoGenerationId, 채널→api→batch→agent 전 구간 전파 식별자.
create table neo.geo_generation (
    geo_generation_id    uuid primary key,
    channel_id    bigint       not null references neo.channel (channel_id),
    dedup_key     varchar(64)  not null,
    locale        varchar(20)  not null,
    product       jsonb        not null,
    -- product_sn: 컬럼명(product_sn)·타입(varchar(100))·NOT NULL은 neo-batch deliver가 그대로 읽으므로 변경 금지.
    product_sn    varchar(100) not null,
    status        varchar(20)  not null,
    error_phase   varchar(20),
    error_code    varchar(50),
    error_detail  text,
    attempt_count int          not null default 0,
    next_retry_at timestamptz,
    claimed_at    timestamptz,
    claimed_by    varchar(100),
    version       bigint       not null default 0,
    created_at    timestamptz  not null,
    updated_at    timestamptz  not null,
    constraint uq_geo_generation_channel_dedup unique (channel_id, dedup_key),
    constraint ck_geo_generation_status check (status in ('ACCEPTED', 'PROCESSING', 'SUCCEEDED', 'FAILED'))
);
create index idx_geo_generation_status on neo.geo_generation (status, next_retry_at);
-- 채널이 자기 접수 건의 상태·JSON-LD를 조회하는 API(GET /v1/geo/generations)용 인덱스.
-- (channel_id = ? and updated_at >= ? and updated_at < ?) 범위 스캔과 updated_at 정렬을 함께 처리한다.
-- updated_at은 상태 전이마다 갱신되므로 이 인덱스는 HOT update를 깬다. 다만 위 idx_geo_generation_status가
-- 이미 status를 포함해 상태 전이는 어차피 non-HOT이라 추가 비용은 작다.
create index idx_geo_generation_channel_updated
    on neo.geo_generation (channel_id, updated_at);

comment on table neo.geo_generation is 'GEO 생성 생애주기(상태 머신). neo-api가 접수 시 생성하고, 이후 전이는 neo-batch·agent-api가 상태 가드 UPDATE로 수행한다.';
comment on column neo.geo_generation.geo_generation_id is '생성 건 PK(UUID). 계약의 geoGenerationId이자 채널→api→batch→agent 전 구간 전파 식별자.';
comment on column neo.geo_generation.channel_id is '요청한 채널 FK(channel.channel_id).';
comment on column neo.geo_generation.dedup_key is
    'GEO 입력(B)의 canonical JSON SHA-256 hex. 멱등 dedup 키. 재접수(forceRegenerate)면 요청 단위 nonce가 섞여 같은 콘텐츠라도 값이 달라진다 — 그래서 content_hash가 아니라 dedup_key다.';
comment on column neo.geo_generation.locale is '결과 언어·지역(BCP 47 태그, 예: ko-KR).';
comment on column neo.geo_generation.product is 'GEO 입력(B)의 product 트리 전체(JSON). 길이 상한 없이 저장하기 위해 jsonb를 쓴다.';
comment on column neo.geo_generation.product_sn is '상품 일련번호(채널 내 고유). 접수 시 product.productSn에서 추출. delivery가 채널에 echo하는 매핑 키.';
comment on column neo.geo_generation.status is
    '생성 상태: ACCEPTED → PROCESSING → SUCCEEDED, 실패 시 FAILED. 채널 전송 상태는 이 컬럼이 아니라 geo_delivery.status가 담는다.';
comment on column neo.geo_generation.error_phase is
    'FAILED일 때 실패 단계: DISPATCH(batch→agent-api 전달) / GENERATION(agent-api 생성). 전송 실패는 geo_delivery.error_code가 담는다.';
comment on column neo.geo_generation.error_code is '실패 코드.';
comment on column neo.geo_generation.error_detail is '실패 상세.';
comment on column neo.geo_generation.attempt_count is 'dispatch 재시도 횟수 누적. 전송 재시도는 geo_delivery.attempt_count가 따로 센다.';
comment on column neo.geo_generation.next_retry_at is 'dispatch 다음 재시도 가능 시각(백오프). 이 시각 이후에만 batch가 픽업.';
comment on column neo.geo_generation.claimed_at is 'dispatch in-flight(PROCESSING) 클레임 시각. 좀비 감지용.';
comment on column neo.geo_generation.claimed_by is 'dispatch 클레임 워커 식별자. 좀비 감지용.';
comment on column neo.geo_generation.version is '낙관적 락 버전.';
comment on column neo.geo_generation.created_at is '접수(생성) 시각.';
comment on column neo.geo_generation.updated_at is '마지막 상태 변경 시각.';
comment on index neo.idx_geo_generation_channel_updated is
    '채널 상태 조회 API의 updated_at 범위 필터·정렬 처리용.';
comment on constraint ck_geo_generation_status on neo.geo_generation is
    '상태값을 4단계 어휘(ACCEPTED/PROCESSING/SUCCEEDED/FAILED)로 제한한다. agent-api 등 이 파이프라인 밖의
    다른 서비스가 폐기된 값(예: 과거 GENERATED)을 쓰면 UPDATE가 조용히 성공해 그 건이 통보 축(geo_delivery)
    어디서도 회수되지 못한 채 방치되는 대신, 즉시 시끄럽게 실패해 사람이 알 수 있게 한다.';

-- 접수 원본 (인터페이스/감사, 불변).
create table neo.geo_interface (
    geo_interface_id  bigserial primary key,
    geo_generation_id uuid        not null references neo.geo_generation (geo_generation_id),
    raw_payload       jsonb       not null,
    source_system     varchar(50),
    requested_at      timestamptz,
    received_at       timestamptz not null
);
create index idx_geo_interface_geo_generation_id on neo.geo_interface (geo_generation_id);

comment on table neo.geo_interface is '접수 원본(인터페이스/감사). 받은 요청 전체를 불변으로 보존한다.';
comment on column neo.geo_interface.geo_interface_id is '접수 원본 PK.';
comment on column neo.geo_interface.geo_generation_id is '연결된 GEO 생성 FK(geo_generation.geo_generation_id).';
comment on column neo.geo_interface.raw_payload is '받은 요청 전체(봉투 A + GEO 입력 B) 원본 JSON.';
comment on column neo.geo_interface.source_system is '호출 시스템 코드(예: PDP-BATCH). 감사용.';
comment on column neo.geo_interface.requested_at is '호출자가 요청을 생성한 시각(선택). 감사용.';
comment on column neo.geo_interface.received_at is 'neo-api가 요청을 수신한 시각.';

-- 생성 산출물 (agent-api 소유. neo-api는 스키마만 관리하고 write 안 함).
-- geo_generation당 1건이라는 불변식을 UNIQUE로 명문화한다.
-- 근거: agent-api(geo-result.repository.ts persistSuccess)가 PROCESSING→SUCCEEDED 상태 가드 UPDATE가
-- 1건 성공한 트랜잭션 안에서만 insert하므로 같은 generation에 두 번 insert될 수 없다. 상품이 수정되면
-- dedup_key가 달라져 새 geo_generation 행이 생기므로 같은 건을 재생성하는 경로도 없다.
-- 이 제약이 있는 상태에서 agent-api가 재생성(regenerate)을 지원하게 되면 insert를 upsert로 바꿔야 한다.
-- UNIQUE 제약이 같은 컬럼의 인덱스를 만들므로 별도 조회 인덱스는 두지 않는다.
create table neo.geo_result (
    geo_result_id bigserial primary key,
    geo_generation_id    uuid        not null references neo.geo_generation (geo_generation_id),
    result_status varchar(30) not null,
    json_ld       jsonb,
    script_tag    text,
    schema_types  jsonb,
    result_hash   varchar(64),
    rag_profile   varchar(100),
    diagnostics   jsonb,
    generated_at  timestamptz not null,
    constraint uq_geo_result_geo_generation unique (geo_generation_id)
);

comment on table neo.geo_result is 'GEO 생성 산출물. agent-api가 소유·기록한다(neo-api는 스키마만 관리, write 안 함).';
comment on column neo.geo_result.geo_result_id is '산출물 PK.';
comment on column neo.geo_result.geo_generation_id is '연결된 GEO 생성 FK(geo_generation.geo_generation_id).';
comment on column neo.geo_result.result_status is '생성 품질: SUCCEEDED / SUCCEEDED_WITH_WARNINGS.';
comment on column neo.geo_result.json_ld is '최종 schema.org JSON-LD.';
comment on column neo.geo_result.script_tag is 'HTML 삽입용 script 태그 문자열.';
comment on column neo.geo_result.schema_types is '생성된 schema @type 목록(예: Product, FAQPage).';
comment on column neo.geo_result.result_hash is '결과 JSON-LD의 SHA-256 hex.';
comment on column neo.geo_result.rag_profile is '적용된 Generator RAG profile 이름.';
comment on column neo.geo_result.diagnostics is '실행 진단 정보(파이프라인·OCR·검증 로그 등).';
comment on column neo.geo_result.generated_at is '결과 생성 시각.';
comment on constraint uq_geo_result_geo_generation on neo.geo_result is
    'generation당 산출물 1건 보장. 조회에서 최신 1건 선별 없이 1:1 join으로 읽을 수 있게 한다.';

-- 채널 통보(전송 축). 접수 1건당 정확히 1행이 만들어지고, DELIVERED가 될 때까지 통보 의무가 살아 있다.
-- 생성 축(geo_generation)과 분리한 이유: 통보 재시도의 error_code/attempt_count가 생성 실패 사유를 덮어쓰면
-- 정작 채널에 보내야 할 내용이 사라진다. neo-api가 INSERT(PENDING)하고 이후 전이는 neo-batch deliver 전담.
create table neo.geo_delivery (
    geo_delivery_id   bigserial   primary key,
    geo_generation_id uuid        not null references neo.geo_generation (geo_generation_id),
    status            varchar(20) not null,
    outcome           varchar(20),
    attempt_count     int         not null default 0,
    next_retry_at     timestamptz,
    claimed_at        timestamptz,
    claimed_by        varchar(100),
    error_code        varchar(50),
    error_detail      text,
    delivered_at      timestamptz,
    created_at        timestamptz not null,
    updated_at        timestamptz not null,
    constraint uq_geo_delivery_geo_generation unique (geo_generation_id),
    constraint ck_geo_delivery_status check (status in ('PENDING', 'DELIVERING', 'DELIVERED', 'FAILED'))
);

-- deliver 클레임용: status='PENDING' 이면서 재시도 시각이 도래한 건을 좁힌다.
create index idx_geo_delivery_pending on neo.geo_delivery (status, next_retry_at);

comment on table neo.geo_delivery is '채널 통보(전송 축) 생애주기. 접수 건당 1행이며 성공·실패와 무관하게 모든 건이 이 축을 갖는다. neo-api가 PENDING으로 생성하고 neo-batch deliver Job이 전이를 전담한다.';
comment on column neo.geo_delivery.geo_delivery_id is '통보 PK.';
comment on column neo.geo_delivery.geo_generation_id is '대상 GEO 생성 FK(geo_generation.geo_generation_id). 생성 건당 통보 1건이라 UNIQUE.';
comment on column neo.geo_delivery.status is '통보 상태: PENDING → DELIVERING → DELIVERED, 통보 포기 시 FAILED. FAILED는 채널이 종결 신호를 받지 못했다는 뜻이라 운영 알림 대상이다.';
comment on column neo.geo_delivery.outcome is '채널에 실제로 보낸 값: SUCCEEDED / FAILED. 전송에 성공(DELIVERED)했을 때만 기록한다 — 못 보낸 건은 null이 정직하다. status와는 다른 축이다(status=통보가 닿았는가, outcome=무엇이라고 알렸는가).';
comment on column neo.geo_delivery.attempt_count is '통보 재시도 횟수 누적. 생성 축(geo_generation.attempt_count)과 예산이 분리되어 있다.';
comment on column neo.geo_delivery.next_retry_at is '다음 통보 재시도 가능 시각(지수 백오프). 이 시각 이후에만 deliver가 픽업.';
comment on column neo.geo_delivery.claimed_at is 'in-flight(DELIVERING) 클레임 시각. 좀비 감지용.';
comment on column neo.geo_delivery.claimed_by is '클레임한 워커 식별자. 좀비 감지용.';
comment on column neo.geo_delivery.error_code is '통보 실패 사유: NO_DELIVERY_URL / HTTP_4xx / HTTP_429 / HTTP_5xx / IO_ERROR / UNKNOWN / DELIVERY_ZOMBIE / MISSING_GENERATION(클레임한 통보 행에 대응하는 geo_generation 행 없음, FK상 이론적으로만 발생). 생성 실패 사유(geo_generation.error_code)를 덮지 않는다.';
comment on column neo.geo_delivery.error_detail is '통보 실패 상세.';
comment on column neo.geo_delivery.delivered_at is '통보 성공 시각.';
comment on column neo.geo_delivery.created_at is '통보 약속 생성 시각(=접수 시각).';
comment on column neo.geo_delivery.updated_at is '마지막 통보 상태 변경 시각.';
comment on constraint uq_geo_delivery_geo_generation on neo.geo_delivery is
    '생성 건당 통보 1건 보장. 접수 트랜잭션에서 함께 만들어지므로 누락도 중복도 없다.';
comment on constraint ck_geo_delivery_status on neo.geo_delivery is
    '상태값을 4단계 어휘(PENDING/DELIVERING/DELIVERED/FAILED)로 제한한다. deliver의 클레임 쿼리는 PENDING만,
    좀비 sweep은 DELIVERING만 찾으므로 어휘 밖의 값이 조용히 쓰이면 그 행은 어떤 복구 경로에도 걸리지 않고
    영원히 방치된다. 그런 UPDATE는 조용히 성공하는 대신 즉시 시끄럽게 실패해야, 채널이 종결 통보를 영영
    받지 못하는 사고를 막을 수 있다.';

-- ===== 이하 픽스처 전용 시드 =====

-- int-spec 들이 geo_generation.channel_id 로 쓰는 채널. test/utils/db.ts 가 이 행을 조회한다.
-- API-KEY 는 channel_api_key 가 보유하므로(원천에서 channel.api_key_hash 는 제거됨) 여기서는 채우지 않는다.
insert into neo.channel (channel_code, name, status, created_at)
values ('TEST', 'Test Channel', 'ACTIVE', now());
