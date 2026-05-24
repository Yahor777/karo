# Requirements Document

## Introduction

AI Agent Orchestrator — это desktop-first приложение для Windows с дополнительной web-версией. Главная версия продукта — полноценное Windows PC приложение, которое позволяет пользователю запускать совместную работу нескольких ИИ-агентов над одной задачей, используя собственный API-ключ выбранного LLM-провайдера (OpenAI, Anthropic и др.).

Web-версия является дополнительным интерфейсом и должна по возможности использовать общую бизнес-логику, UI-компоненты и backend-сервисы с Windows-приложением. Windows-приложение не должно быть просто optional wrapper вокруг web-приложения: оно должно быть самостоятельной основной версией продукта и должно быть полноценно usable без зависимости от hosted web версии.

Платформа полностью бесплатна для пользователя: оплата идёт только за токены через его личный API-ключ. При необходимости может использоваться опциональный fallback на дешёвые или бесплатные резервные модели платформы, если ключ пользователя недействителен, недоступен или достиг лимита.

Пользователь может войти только через API-ключ без аккаунта, тогда настройки и ключи хранятся локально на Windows-устройстве. Также пользователь может авторизоваться через Gmail OAuth, что позволяет синхронизировать его API-ключи и настройки между Windows-приложением и web-версией.

После авторизации пользователь выбирает модель, формирует промт, выбирает участвующих агентов или режим Auto, и наблюдает за их работой через UI с видимостью «мыслей» каждого агента и изменённых файлов. Платформа предоставляет 5 встроенных агентов: Researcher, Coder, Reviewer, Fixer, Boss — и поддерживает создание кастомных агентов. Все агенты могут использовать бесплатный инструмент веб-поиска на основе DuckDuckGo и обмениваться сообщениями между собой по заданному пайплайну.

## Glossary

- **Windows_Desktop_App**: основная версия продукта для Windows PC. Предоставляет полный UI, локальное хранилище, управление сессиями, запуск задач и просмотр Agent_Trace/File_Artifact.
- **Web_App**: дополнительная web-версия продукта, использующая общую бизнес-логику и backend-сервисы с Windows_Desktop_App.
- **Desktop_Shell**: оболочка Windows-приложения, отвечающая за нативную интеграцию с ОС, локальное зашифрованное хранилище, обновления приложения и запуск UI.
- **Web_Shell**: web-интерфейс приложения, работающий через браузер и подключающийся к тем же backend/orchestrator сервисам.
- **Shared_Core**: общая бизнес-логика, типы, схемы валидации, UI-компоненты и клиентские сервисы, переиспользуемые между Windows_Desktop_App и Web_App.
- **Orchestrator**: основная серверная подсистема, которая управляет жизненным циклом задач и координирует работу агентов.
- **User**: пользователь платформы.
- **Auth_Service**: подсистема, отвечающая за аутентификацию пользователя через Gmail OAuth, валидацию API-ключей и создание локальных или облачных сессий.
- **Settings_Store**: подсистема хранения пользовательских настроек: API-ключи, кастомные агенты, предпочтения, локальные настройки Windows-приложения и облачно-синхронизированные настройки.
- **Local_Settings_Store**: локальное зашифрованное хранилище Windows-приложения для сессий без Gmail.
- **Cloud_Settings_Store**: облачное хранилище настроек для Gmail-сессий, синхронизируемое между Windows-приложением и Web_App.
- **API_Key**: секретный ключ LLM-провайдера, предоставленный пользователем для вызова моделей.
- **Platform_Backup_Key**: опциональный резервный API-ключ платформы, используемый только для явно настроенных дешёвых или бесплатных fallback-моделей.
- **Provider**: внешний LLM-провайдер: OpenAI, Anthropic и т.д.
- **Model**: конкретная модель LLM, доступная по API_Key пользователя или через разрешённый fallback.
- **Model_Catalog**: подсистема, которая по предоставленному API_Key получает список доступных пользователю моделей у Provider.
- **Agent**: автономная единица, выполняющая определённую роль в обработке задачи; имеет имя, системный промт, набор разрешённых инструментов и используемую Model.
- **Builtin_Agent**: один из пяти предустановленных агентов: Researcher, Coder, Reviewer, Fixer, Boss.
- **Researcher**: Builtin_Agent, который собирает информацию по промту пользователя и обогащает промт перед передачей дальше.
- **Coder**: Builtin_Agent, который пишет код на основе обогащённого промта.
- **Reviewer**: Builtin_Agent, который проверяет результат Coder/Fixer на наличие багов.
- **Fixer**: Builtin_Agent, который исправляет баги, найденные Reviewer.
- **Boss**: Builtin_Agent, который проверяет соответствие итогового результата исходному промту пользователя и принимает финальное решение.
- **Custom_Agent**: агент, созданный пользователем, с заданным именем, системным промтом, моделью и набором инструментов.
- **Auto_Mode**: режим, в котором Orchestrator самостоятельно выбирает участвующих агентов исходя из промта.
- **Manual_Mode**: режим, в котором пользователь явно выбирает участвующих агентов.
- **Pipeline**: упорядоченная последовательность шагов с участием агентов для обработки одной задачи.
- **Task**: единица работы, инициированная пользователем одним промтом и выполняемая Pipeline.
- **Web_Search_Tool**: инструмент поиска в интернете, доступный агентам; основан на DuckDuckGo и не требует платного ключа.
- **Agent_Message**: структурированное сообщение, передаваемое между агентами в рамках Task.
- **Agent_Trace**: запись «мыслей» агента, вызовов инструментов и изменённых файлов в рамках Task.
- **File_Artifact**: файл, созданный или изменённый агентом в рамках Task.
- **Review_Cycle**: один проход Reviewer → Fixer → Reviewer.
- **Final_Report**: итоговый отчёт пользователю, формируемый Boss по завершении Task.

## Requirements

### Requirement 1: Desktop-first продукт для Windows

**User Story:** Как пользователь Windows PC, я хочу иметь полноценное desktop-приложение, чтобы запускать AI Agent Orchestrator как обычную программу на компьютере, а не зависеть только от web-версии.

#### Acceptance Criteria

1. THE system SHALL treat Windows_Desktop_App as the primary product target.
2. THE system SHALL provide Web_App as a secondary additional interface, not as the main product.
3. THE Windows_Desktop_App SHALL be fully usable without depending on a hosted Web_App.
4. THE Windows_Desktop_App SHALL provide the full core user flow: authentication, API-key management, model selection, task creation, agent trace viewing, file artifact viewing and final report viewing.
5. THE architecture SHALL separate Desktop_Shell, Web_Shell, Shared_Core, backend/orchestrator services and storage.
6. THE Desktop_Shell SHALL provide local encrypted storage for API-key-only sessions on the Windows device.
7. THE Web_App SHALL reuse Shared_Core and backend/orchestrator services where possible to avoid duplicating business logic.
8. THE system SHALL NOT describe or implement Windows_Desktop_App as merely an optional wrapper around Web_App.

### Requirement 2: Авторизация через API-ключ

**User Story:** Как пользователь, я хочу войти в Windows-приложение, указав свой API-ключ LLM-провайдера, чтобы сразу начать работу без создания аккаунта.

#### Acceptance Criteria

1. WHEN пользователь открывает Windows_Desktop_App или Web_App и не имеет активной сессии, THE Auth_Service SHALL отобразить экран входа с двумя вариантами: «Ввести API-ключ» и «Войти через Gmail».
2. WHEN пользователь выбирает «Ввести API-ключ» и отправляет значение API_Key и идентификатор Provider, THE Auth_Service SHALL валидировать API_Key через тестовый запрос к Provider до создания сессии.
3. IF API_Key недействителен или Provider возвращает ошибку аутентификации, THEN THE Auth_Service SHALL отклонить вход и отобразить пользователю сообщение об ошибке с указанием причины, полученной от Provider.
4. WHEN API_Key успешно провалидирован, THE Auth_Service SHALL запросить у пользователя явное подтверждение создания сессии и локального сохранения API_Key до выполнения этих действий.
5. WHEN пользователь подтверждает создание сессии в Windows_Desktop_App, THE Auth_Service SHALL создать локальную сессию без привязки к Google-аккаунту и сохранить API_Key только в Local_Settings_Store Windows-устройства.
6. WHILE сессия создана только через API-ключ без Gmail, THE Settings_Store SHALL ограничивать синхронизацию настроек только текущим устройством.
7. WHEN пользователь, имевший сессию только по API-ключу, дополнительно авторизуется через Gmail в той же сессии, THE Settings_Store SHALL предложить перенести ранее сохранённые локально настройки в Cloud_Settings_Store учётной записи и SHALL включить их синхронизацию между Windows_Desktop_App и Web_App после подтверждения пользователя.
8. THE system SHALL NOT sync API_Key to cloud without explicit user confirmation.

### Requirement 3: Авторизация через Gmail и синхронизация настроек

**User Story:** Как пользователь, я хочу входить через Gmail, чтобы мои API-ключи и настройки синхронизировались между Windows-приложением и web-версией без повторного ввода.

#### Acceptance Criteria

1. WHEN пользователь выбирает «Войти через Gmail», THE Auth_Service SHALL инициировать OAuth 2.0 авторизацию у Google и запросить только минимально необходимый набор scope для идентификации пользователя.
2. WHEN Google подтверждает идентичность пользователя, THE Auth_Service SHALL создать или восстановить учётную запись пользователя по уникальному идентификатору Google-аккаунта.
3. WHEN пользователь авторизован через Gmail и в настройках вводит API_Key для Provider, THE Settings_Store SHALL сохранить API_Key в зашифрованном виде, привязав его к учётной записи пользователя.
4. WHEN пользователь, авторизованный через Gmail, входит в Windows_Desktop_App или Web_App с другого устройства, THE Settings_Store SHALL предоставить ранее сохранённые API_Key и пользовательские настройки текущей сессии без повторного ввода.
5. IF Settings_Store не может получить сохранённые настройки и API_Key из-за сбоя сети или хранилища при входе пользователя через Gmail, THEN THE Auth_Service SHALL прервать вход и предложить пользователю повторить попытку позднее.
6. IF при синхронизации настроек уже авторизованной сессии происходит сбой на стороне Settings_Store, THEN THE Settings_Store SHALL вернуть пользователю описательную ошибку и сохранить локально внесённые в текущей сессии изменения до восстановления синхронизации.
7. THE Settings_Store SHALL хранить API_Key пользователя в зашифрованном виде и SHALL предоставлять его в открытом виде только в ответ на явный запрос серверного компонента, выполняющего вызов Provider от имени пользователя.

### Requirement 4: Управление API-ключами и провайдерами

**User Story:** Как пользователь, я хочу управлять несколькими API-ключами для разных провайдеров, чтобы выбирать любой поддерживаемый ИИ.

#### Acceptance Criteria

1. THE Settings_Store SHALL позволять пользователю добавлять, обновлять и удалять API_Key для каждого поддерживаемого Provider.
2. WHEN пользователь добавляет или обновляет API_Key, THE Auth_Service SHALL валидировать его тестовым запросом к соответствующему Provider до сохранения.
3. IF тестовый запрос на валидацию API_Key завершается ошибкой аутентификации от Provider, THEN THE Auth_Service SHALL отклонить сохранение и отобразить причину ошибки.
4. WHEN пользователь удаляет API_Key, THE Settings_Store SHALL удалить ключ из хранилища, сделать недоступными модели соответствующего Provider до повторного добавления ключа и SHALL не отображать пользователю сообщение об ошибке при успешном удалении.
5. THE Windows_Desktop_App SHALL store local API_Key values in encrypted local storage when the user is not using Gmail synchronization.

### Requirement 5: Каталог моделей по API-ключу

**User Story:** Как пользователь, я хочу видеть список моделей, доступных по моему API-ключу, чтобы выбрать подходящую перед запуском задачи.

#### Acceptance Criteria

1. WHEN пользователь открывает экран запуска задачи, THE Model_Catalog SHALL запросить у каждого настроенного Provider список доступных пользователю Model по соответствующему API_Key.
2. THE Model_Catalog SHALL отображать только те Model, которые доступны пользователю по предоставленному API_Key.
3. IF Provider возвращает ошибку при запросе списка моделей, THEN THE Model_Catalog SHALL отобразить пользователю сообщение об ошибке с указанием Provider и причины и SHALL не блокировать отображение моделей других Provider.
4. WHEN пользователь выбирает Model для Task, THE Orchestrator SHALL использовать выбранную Model по умолчанию для всех агентов Task, если для агента не задана иная Model.
5. IF configured platform fallback models exist, THEN THE Model_Catalog SHALL clearly label them as fallback/basic models and SHALL NOT mix them silently with user-key models.

### Requirement 6: Создание задачи

**User Story:** Как пользователь, я хочу ввести промт и выбрать агентов или включить режим Auto, чтобы запустить совместную работу агентов.

#### Acceptance Criteria

1. WHEN пользователь открывает экран создания Task, THE Orchestrator SHALL отобразить поле ввода промта, выбор Model, переключатель режимов Auto_Mode/Manual_Mode и список доступных агентов с возможностью выбора участников.
2. WHEN пользователь выбирает Manual_Mode, THE Orchestrator SHALL позволить пользователю выбрать одного или нескольких агентов из списка Builtin_Agent и Custom_Agent.
3. WHEN пользователь выбирает Auto_Mode, THE Orchestrator SHALL автоматически определить набор и порядок агентов для Task на основе содержания промта.
4. IF пользователь пытается запустить Task без введённого промта, THEN THE Orchestrator SHALL отклонить запуск и отобразить сообщение об отсутствии промта.
5. WHILE поле промта пусто, THE Orchestrator SHALL отображать кнопку запуска Task в неактивном состоянии и блокировать инициирование Task.
6. IF пользователь в Manual_Mode пытается запустить Task с нулевым числом выбранных агентов, THEN THE Orchestrator SHALL отклонить запуск и потребовать выбрать хотя бы одного Agent.
7. IF пользователь пытается запустить Task без выбранной Model или без действительного API_Key для выбранной Model, THEN THE Orchestrator SHALL отклонить запуск и указать отсутствующее условие.
8. WHEN пользователь подтверждает запуск Task, THE Orchestrator SHALL создать новый Task с уникальным идентификатором, сохранить выбранные параметры и инициировать Pipeline.

### Requirement 7: Встроенные агенты и их роли

**User Story:** Как пользователь, я хочу иметь пять предустановленных агентов с чёткими ролями, чтобы обработка задачи покрывала исследование, кодирование, ревью, исправление и финальную проверку.

#### Acceptance Criteria

1. THE Orchestrator SHALL предоставлять ровно пять Builtin_Agent с уникальными ролями: Researcher, Coder, Reviewer, Fixer и Boss.
2. WHEN Researcher получает Agent_Message с промтом пользователя, THE Researcher SHALL в течение не более 60 секунд собрать дополнительную информацию с использованием Model и Web_Search_Tool и SHALL передать следующему агенту в Pipeline обогащённый промт, содержащий исходный промт пользователя и собранный контекст.
3. IF Web_Search_Tool недоступен или возвращает ошибку при выполнении Researcher, THEN THE Researcher SHALL сформировать обогащённый промт только на основе Model и SHALL включить в обогащённый промт индикатор отсутствия результатов веб-поиска без прерывания Pipeline.
4. WHEN Coder получает обогащённый промт от Researcher, THE Coder SHALL атомарно сформировать код в виде одного File_Artifact и SHALL передать результат Reviewer как единое действие без промежуточных состояний, видимых другим агентам.
5. WHEN Reviewer получает File_Artifact от Coder или Fixer, THE Reviewer SHALL проверить результат на наличие функциональных, синтаксических и логических дефектов и SHALL вернуть результат проверки в виде списка с описанием каждого найденного дефекта либо явного подтверждения отсутствия дефектов.
6. WHEN Reviewer возвращает непустой список найденных проблем, THE Orchestrator SHALL передать список проблем и текущий File_Artifact агенту Fixer для исправления.
7. WHEN Fixer получает список проблем от Reviewer, THE Fixer SHALL применить исправления к File_Artifact и SHALL вернуть обновлённый File_Artifact Reviewer как единое действие.
8. WHILE цикл Reviewer–Fixer выполняется, THE Orchestrator SHALL ограничить количество итераций исправления значением не более 5 и SHALL при достижении лимита прервать цикл с передачей текущего File_Artifact и накопленного списка нерешённых проблем агенту Boss.
9. WHEN Reviewer подтверждает отсутствие проблем, THE Orchestrator SHALL передать итоговый File_Artifact агенту Boss.
10. WHEN Boss получает результат от Reviewer, THE Boss SHALL сравнить итог с исходным промтом пользователя по критериям полноты выполнения требований и отсутствия противоречий с промтом и SHALL вынести одно из двух решений: «соответствует» либо «не соответствует» с перечнем конкретных замечаний.
11. IF Boss выносит решение «не соответствует», THEN THE Orchestrator SHALL вернуть пользователю итоговый File_Artifact и перечень замечаний как результат обработки задачи без автоматического повторного запуска Pipeline.

### Requirement 8: Поток выполнения и циклы ревью

**User Story:** Как пользователь, я хочу, чтобы агенты работали по заданному порядку с повторными итерациями ревью, чтобы итог соответствовал моему промту.

#### Acceptance Criteria

1. THE Orchestrator SHALL выполнять Pipeline в порядке: Researcher → Coder → Reviewer → (Fixer → Reviewer)* → Boss.
2. WHEN Reviewer возвращает список проблем, THE Orchestrator SHALL запустить очередной Review_Cycle путём передачи проблем Fixer.
3. WHEN Boss выносит решение «не соответствует», THE Orchestrator SHALL вернуть результат с замечаниями Boss во Fixer для повторной обработки.
4. WHEN Fixer завершает обработку замечаний Boss, THE Orchestrator SHALL направить результат снова Reviewer перед повторной передачей Boss.
5. THE Orchestrator SHALL ограничивать количество Review_Cycle для одной Task настраиваемым значением, по умолчанию равным 5.
6. IF количество выполненных Review_Cycle достигает настроенного предела без получения от Boss решения «соответствует», THEN THE Orchestrator SHALL остановить Task и вернуть пользователю отчёт с историей итераций и текущими замечаниями.
7. WHEN Boss выносит решение «соответствует», THE Orchestrator SHALL завершить Task и сформировать Final_Report для пользователя.

### Requirement 9: Веб-поиск как бесплатный инструмент агентов

**User Story:** Как пользователь, я хочу, чтобы агенты могли искать информацию в интернете без платных сервисов, чтобы платформа оставалась бесплатной за пределами стоимости моих токенов.

#### Acceptance Criteria

1. THE Orchestrator SHALL предоставлять каждому Agent доступ к Web_Search_Tool, использующему DuckDuckGo как поисковый бэкенд.
2. THE Web_Search_Tool SHALL не требовать от пользователя ввода каких-либо платных ключей или подписок.
3. WHEN Agent вызывает Web_Search_Tool с поисковым запросом, THE Web_Search_Tool SHALL вернуть список результатов с заголовком, URL и сниппетом для каждого результата.
4. IF DuckDuckGo возвращает ошибку или пустой ответ, THEN THE Web_Search_Tool SHALL вернуть Agent описательную ошибку без аварийного завершения Task.
5. THE Orchestrator SHALL фиксировать каждый вызов Web_Search_Tool в Agent_Trace соответствующего Agent с указанием запроса и краткого результата.

### Requirement 10: Межагентная коммуникация

**User Story:** Как пользователь, я хочу, чтобы агенты обменивались структурированными сообщениями, чтобы каждый последующий агент имел контекст от предыдущих.

#### Acceptance Criteria

1. THE Orchestrator SHALL передавать информацию между Agent в виде Agent_Message со следующими обязательными полями: идентификатор Task, отправитель, получатель, тип сообщения, полезная нагрузка и временная метка.
2. THE Task id in Agent_Message SHALL be a non-empty string from 1 to 128 characters.
3. THE Agent_Message type SHALL be one of: "request", "response", "error", "handoff".
4. THE payload size SHALL NOT exceed 1 MB.
5. THE timestamp SHALL use ISO 8601 UTC format with millisecond precision.
6. WHEN Agent завершает свой шаг, THE Orchestrator SHALL сохранить итоговое Agent_Message в истории Task в течение не более 500 мс до передачи управления следующему Agent.
7. WHEN Orchestrator вызывает Agent, THE Orchestrator SHALL предоставить Agent доступ к полной истории Agent_Message текущей Task в хронологическом порядке по возрастанию временной метки, ограниченной последними 200 сообщениями или общим объёмом 8 MB.
8. IF Agent возвращает результат, не соответствующий формату Agent_Message, THEN THE Orchestrator SHALL обернуть полученные данные в валидное Agent_Message с типом "response", заполнить отсутствующие поля значениями по умолчанию, установить флаг нормализации формата и сохранить исходный ответ в полезной нагрузке без изменений.
9. IF результат Agent не может быть прочитан или интерпретирован как текст или структурированные данные, THEN THE Orchestrator SHALL сформировать Agent_Message с типом "error", индикацией причины сбоя коммуникации и сохранить его в истории Task без прерывания других сохранённых сообщений.

### Requirement 11: Видимость «мыслей» и артефактов агентов в UI

**User Story:** Как пользователь, я хочу нажать на агента и увидеть его рассуждения, вызовы инструментов и изменённые файлы, чтобы понимать ход работы.

#### Acceptance Criteria

1. WHILE Task выполняется, THE Orchestrator SHALL отображать в UI список всех участвующих Agent с их текущим статусом: ожидает, выполняет, завершил, ошибка.
2. WHEN пользователь нажимает на конкретный Agent в UI, THE Orchestrator SHALL отобразить его Agent_Trace, включая последовательность рассуждений, вызовов инструментов с входами и выходами, и список File_Artifact, созданных или изменённых этим Agent.
3. THE Orchestrator SHALL обновлять Agent_Trace в UI по мере поступления новых записей с задержкой не более 2 секунд от момента генерации записи.
4. WHEN пользователь явно выбирает File_Artifact в Agent_Trace, THE Orchestrator SHALL отобразить содержимое файла и, при наличии предыдущей версии, диф между версиями.
5. THE Orchestrator SHALL не отображать диф File_Artifact автоматически или по иным триггерам, кроме явного выбора пользователем.
6. IF задержка обновления Agent_Trace в UI превышает 2 секунды из-за сетевых задержек или замедления обработки, THEN THE Orchestrator SHALL продолжить нормальную работу и SHALL применить обновление по мере его готовности без блокировки взаимодействия пользователя с UI.
7. THE Orchestrator SHALL сохранять полный Agent_Trace и все File_Artifact для завершённых Task и SHALL делать их доступными пользователю при последующих просмотрах.
8. THE Windows_Desktop_App and Web_App SHALL provide consistent UI behavior for Agent_Trace and File_Artifact viewing.

### Requirement 12: Кастомные агенты

**User Story:** Как пользователь, я хочу создавать собственных агентов с заданным системным промтом и набором инструментов, чтобы расширять платформу под свои сценарии.

#### Acceptance Criteria

1. THE Settings_Store SHALL позволять пользователю создавать Custom_Agent с обязательными полями: имя, системный промт, выбор Model, набор разрешённых инструментов.
2. WHEN пользователь сохраняет нового Custom_Agent, THE Settings_Store SHALL валидировать уникальность имени в пределах учётной записи пользователя и непустоту системного промта.
3. IF имя Custom_Agent совпадает с именем существующего Builtin_Agent или другого Custom_Agent пользователя, THEN THE Settings_Store SHALL отклонить сохранение и сообщить о конфликте имён.
4. WHEN пользователь редактирует или удаляет Custom_Agent, THE Settings_Store SHALL применить изменения к текущей области хранения пользователя.
5. IF пользователь авторизован через Gmail, THEN THE Settings_Store SHALL синхронизировать Custom_Agent между Windows_Desktop_App и Web_App.
6. WHEN пользователь запускает Task с участием Custom_Agent, THE Orchestrator SHALL обращаться с Custom_Agent одинаково с Builtin_Agent в части доступа к Web_Search_Tool, Agent_Message и Agent_Trace.

### Requirement 13: Бесплатная модель использования платформы

**User Story:** Как пользователь, я хочу пользоваться платформой бесплатно и платить только за свои токены, чтобы не было обязательных платежей за саму платформу.

#### Acceptance Criteria

1. THE Orchestrator SHALL не взимать с пользователя плату за использование платформы.
2. THE Orchestrator SHALL выполнять все вызовы Model по умолчанию через API_Key пользователя для соответствующего Provider.
3. WHERE настроена опциональная функция резервного API-ключа платформы, IF вызов Model через API_Key пользователя завершается ошибкой Provider о недействительном ключе или превышении лимита, THEN THE Orchestrator SHALL offer fallback to an explicitly configured cheap/free platform fallback model.
4. THE Orchestrator SHALL notify the user before switching from the user's API_Key to a platform fallback key.
5. Platform_Backup_Key SHALL only be used for explicitly configured fallback models.
6. Fallback usage SHALL be rate-limited and may provide reduced model quality.
7. Premium or high-cost fallback models SHALL NOT be used unless explicitly enabled by the platform owner.
8. THE Orchestrator SHALL не использовать сторонние платные сервисы, требующие отдельной подписки от пользователя, для функций, перечисленных в Требованиях 1–12.
9. WHERE интеграция с дополнительным платным сервисом будет добавлена в будущем, THE Orchestrator SHALL делать такую интеграцию явно опциональной и SHALL сохранять полную работоспособность платформы без неё.

### Requirement 14: Финальный отчёт пользователю

**User Story:** Как пользователь, я хочу получить итоговый отчёт по завершении задачи, чтобы увидеть результат и историю работы агентов.

#### Acceptance Criteria

1. THE Orchestrator SHALL разрешать Boss выносить решение «соответствует» только после того, как для текущей Task выполнен хотя бы один Review_Cycle.
2. WHEN Boss выносит решение «соответствует», THE Orchestrator SHALL сформировать Final_Report, содержащий: исходный промт, итоговые File_Artifact, краткое резюме от Boss, список участвовавших Agent и количество выполненных Review_Cycle.
3. THE Orchestrator SHALL отобразить Final_Report пользователю в UI и SHALL предоставить возможность скачать итоговые File_Artifact.
4. WHEN Task остановлена по достижении лимита Review_Cycle без согласия Boss, THE Orchestrator SHALL сформировать Final_Report со статусом «не завершено» и перечнем оставшихся замечаний.
5. THE Orchestrator SHALL сохранять Final_Report для последующего просмотра пользователем в истории его Task.